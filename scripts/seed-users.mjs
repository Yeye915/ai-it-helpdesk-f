import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const envPath = fileURLToPath(new URL('../.env.local', import.meta.url));
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const separator = trimmed.indexOf('=');
  if (separator < 1) continue;
  const key = trimmed.slice(0, separator).trim();
  const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  if (!process.env[key]) process.env[key] = value;
}

const required = ['MONGODB_URI', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'DEMO_USER_EMAIL', 'DEMO_USER_PASSWORD'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Thiếu ${key} trong .env.local`);
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  role: { type: String, required: true, enum: ['admin', 'user'] },
  passwordHash: { type: String, required: true, select: false },
}, { timestamps: true, collection: 'users' }));

const accounts = [
  { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, name: 'Mai Phương Dương', role: 'admin' },
  { email: process.env.DEMO_USER_EMAIL, password: process.env.DEMO_USER_PASSWORD, name: 'Nhân viên Helpdesk', role: 'user' },
];
if (process.env.ADDITIONAL_USER_EMAIL && process.env.ADDITIONAL_USER_PASSWORD) {
  accounts.push({
    email: process.env.ADDITIONAL_USER_EMAIL,
    password: process.env.ADDITIONAL_USER_PASSWORD,
    name: process.env.ADDITIONAL_USER_NAME || 'Người dùng mẫu 2',
    role: 'user',
  });
}

try {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'it_helpdesk' });
  for (const account of accounts) {
    await User.updateOne(
      { email: account.email.toLowerCase() },
      { $set: { name: account.name, role: account.role, passwordHash: hashPassword(account.password) } },
      { upsert: true }
    );
  }
  const savedAccounts = await User.find({ email: { $in: accounts.map(({ email }) => email.toLowerCase()) } })
    .select('+passwordHash email role')
    .lean();
  if (savedAccounts.length !== accounts.length || savedAccounts.some(({ passwordHash }) => !passwordHash?.startsWith('scrypt$'))) {
    throw new Error('Xác minh tài khoản hoặc password hash không thành công.');
  }
  console.log(`Đã xác minh ${savedAccounts.length} tài khoản trong collection users; mật khẩu được lưu dưới dạng scrypt hash.`);
} finally {
  await mongoose.disconnect();
}

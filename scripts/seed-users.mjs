// Nhi
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import { loadEnvironment } from './environment.mjs';

loadEnvironment();
const derive = promisify(scrypt);
for (const key of ['MONGODB_URI', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'DEMO_USER_EMAIL', 'DEMO_USER_PASSWORD']) {
  if (!process.env[key]) throw new Error(`Thiếu ${key}.`);
}
if (Boolean(process.env.ADDITIONAL_USER_EMAIL) !== Boolean(process.env.ADDITIONAL_USER_PASSWORD)) throw new Error('Cần khai báo cả ADDITIONAL_USER_EMAIL và ADDITIONAL_USER_PASSWORD.');
const accounts = [
  { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, name: 'Mai Phương Dương', role: 'admin' },
  { email: process.env.DEMO_USER_EMAIL, password: process.env.DEMO_USER_PASSWORD, name: 'Nhân viên Helpdesk', role: 'user' },
];
if (process.env.ADDITIONAL_USER_EMAIL) accounts.push({ email: process.env.ADDITIONAL_USER_EMAIL, password: process.env.ADDITIONAL_USER_PASSWORD, name: process.env.ADDITIONAL_USER_NAME?.trim() || 'Người dùng mẫu 2', role: 'user' });
for (const account of accounts) {
  account.email = account.email.trim().toLowerCase();
  if (account.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email)) throw new Error('Email seed không hợp lệ.');
  if (account.password.length < 8 || account.password.length > 128) throw new Error('Mật khẩu seed cần từ 8 đến 128 ký tự.');
  if (account.name.length > 80) throw new Error('Tên tài khoản seed quá dài.');
}
if (new Set(accounts.map((account) => account.email)).size !== accounts.length) throw new Error('Email seed bị trùng giữa các vai trò.');
const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
  email: { type: String, unique: true, required: true }, name: { type: String, required: true },
  role: { type: String, enum: ['admin', 'user'], required: true }, passwordHash: { type: String, required: true, select: false },
}, { timestamps: true, collection: 'users' }));

try {
  const values = await Promise.all(accounts.map(async ({ password, ...account }) => {
    const salt = randomBytes(16).toString('hex');
    const hash = await derive(password, salt, 64);
    return { ...account, passwordHash: `scrypt$${salt}$${hash.toString('hex')}` };
  }));
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'it_helpdesk', maxPoolSize: 2, serverSelectionTimeoutMS: 8000 });
  await User.init();
  await User.bulkWrite(values.map((account) => ({ updateOne: { filter: { email: account.email }, update: { $set: account }, upsert: true } })));
  const saved = await User.find({ email: { $in: values.map((account) => account.email) } }).select('+passwordHash email role').lean();
  if (saved.length !== values.length || saved.some((account) => !values.some((value) => value.email === account.email && value.passwordHash === account.passwordHash && value.role === account.role))) throw new Error('Seed verification failed');
  console.log(`Đã xác minh ${saved.length} tài khoản; mật khẩu được băm bằng scrypt.`);
} catch (error) {
  console.error('Không thể seed tài khoản:', error instanceof Error ? error.name : 'UnknownError');
  process.exitCode = 1;
} finally { await mongoose.disconnect(); }

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error('Vui lòng định nghĩa biến MONGODB_URI trong file .env.local');
}

const globalWithMongoose = globalThis as typeof globalThis & {
  mongoose?: {
    conn: typeof mongoose | null;
    promise: Promise<typeof mongoose> | null;
  };
};
const cached = globalWithMongoose.mongoose ??= { conn: null, promise: null };

async function connectDB() {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const opts = {
      bufferCommands: false,
      dbName: process.env.MONGODB_DB || 'it_helpdesk',
    };
    cached.promise = mongoose.connect(MONGODB_URI!, opts).catch((error) => {
      // Let a later request retry instead of reusing a permanently rejected promise.
      cached.promise = null;
      throw error;
    });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

export default connectDB;

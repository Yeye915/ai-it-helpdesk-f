// Nhi
import mongoose from 'mongoose';

type ConnectionCache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null; listenersBound: boolean };
const globalWithMongo = globalThis as typeof globalThis & { helpdeskMongo?: ConnectionCache };
const cached = globalWithMongo.helpdeskMongo ??= { conn: null, promise: null, listenersBound: false };

export default async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw Object.assign(new Error('Vui lòng định nghĩa MONGODB_URI.'), { code: 'MONGODB_URI_MISSING' });
  if (cached.conn && mongoose.connection.readyState === 1) return cached.conn;
  if (cached.promise) return cached.promise;
  if (!cached.listenersBound) {
    mongoose.connection.on('disconnected', () => { cached.conn = null; });
    cached.listenersBound = true;
  }
  const pending = mongoose.connect(uri, {
    bufferCommands: false, dbName: process.env.MONGODB_DB || 'it_helpdesk',
    serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, socketTimeoutMS: 45000,
    maxPoolSize: 10, minPoolSize: 0, maxIdleTimeMS: 30000,
  });
  cached.promise = pending;
  try { cached.conn = await pending; return cached.conn; }
  catch (error) { cached.conn = null; throw error; }
  finally { if (cached.promise === pending) cached.promise = null; }
}

export function isMongoConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === 'MONGODB_URI_MISSING' || /(?:Mongoose|Mongo)ServerSelectionError|MongoNetwork(?:Timeout)?Error|MongoNotConnectedError/.test(error.name);
}

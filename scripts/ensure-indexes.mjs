import mongoose from 'mongoose';
import { loadEnvironment } from './environment.mjs';

loadEnvironment();
if (!process.env.MONGODB_URI) throw new Error('Thiếu MONGODB_URI.');
try {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'it_helpdesk', maxPoolSize: 2, serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.db;
  await db.collection('tickets').createIndex({ ticketId: 1 }, { unique: true });
  await db.collection('tickets').createIndex({ createdAt: -1, _id: -1 });
  await db.collection('tickets').createIndex({ status: 1, createdAt: -1, _id: -1 });
  await db.collection('tickets').createIndex({ updatedAt: -1, createdAt: -1, _id: -1 });
  // Legacy audit rows have no eventId, so index only the new format.
  await db.collection('ticket_audit').createIndex({ eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } });
  console.log('Đã tạo/kiểm tra index ticket và audit; giữ nguyên dữ liệu và index khác.');
} catch (error) {
  console.error('Không thể tạo index:', error instanceof Error ? error.name : 'UnknownError');
  process.exitCode = 1;
} finally { await mongoose.disconnect(); }

import mongoose, { Schema, type Document, type Model } from 'mongoose';

export interface IUser extends Document {
  email: string;
  name: string;
  role: 'admin' | 'user';
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, required: true, enum: ['admin', 'user'] },
    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true, collection: 'users' }
);

export default (mongoose.models.User as Model<IUser> | undefined) || mongoose.model<IUser>('User', UserSchema);

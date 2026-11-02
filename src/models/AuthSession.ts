// Nhi
import mongoose, { Schema, type Model, type Types } from "mongoose";

interface SessionRecord {
  tokenHash: string;
  userId: Types.ObjectId;
  expiresAt: Date;
}

const sessionSchema = new Schema<SessionRecord>({
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
});

export const AuthSession =
  (mongoose.models.AuthSession as Model<SessionRecord> | undefined) ??
  mongoose.model<SessionRecord>("AuthSession", sessionSchema);

interface AttemptRecord {
  _id: string;
  count: number;
  expiresAt: Date;
}

const attemptSchema = new Schema<AttemptRecord>({
  _id: { type: String, required: true },
  count: { type: Number, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
});

export const AuthAttempt =
  (mongoose.models.AuthAttempt as Model<AttemptRecord> | undefined) ??
  mongoose.model<AttemptRecord>("AuthAttempt", attemptSchema);

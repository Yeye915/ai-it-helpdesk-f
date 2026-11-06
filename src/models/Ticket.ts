// Nhi
import mongoose, { Schema, type Document, type Model } from 'mongoose';

export interface ITicket extends Document {
  ticketId: string;
  title: string;
  description: string;
  category: string;
  priority: string;
  assignedTeam: string;
  aiReason: string;
  aiSuggestion: string;
  status: string;
  createdAt: Date;
  updatedAt?: Date;
}

const TicketSchema = new Schema<ITicket>({
  ticketId: { type: String, required: true, unique: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, required: true, trim: true, maxlength: 10000 },
  category: { type: String, default: 'Unassigned' },
  priority: { type: String, enum: ['Critical', 'High', 'Medium', 'Low'], default: 'Medium' },
  assignedTeam: { type: String, default: 'IT General' },
  aiReason: { type: String, default: '' },
  aiSuggestion: { type: String, default: '' },
  status: { type: String, enum: ['Open', 'In Progress', 'Resolved'], default: 'Open' },
}, { timestamps: true });

TicketSchema.index({ createdAt: -1, _id: -1 });
TicketSchema.index({ status: 1, createdAt: -1, _id: -1 });
TicketSchema.index({ updatedAt: -1, createdAt: -1, _id: -1 });

export default (mongoose.models.Ticket as Model<ITicket> | undefined) || mongoose.model<ITicket>('Ticket', TicketSchema);

// Nhi
import mongoose, { Schema, Document } from 'mongoose';

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
}

const TicketSchema: Schema = new Schema({
  ticketId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  category: { type: String, default: 'Unassigned' },
  priority: { type: String, enum: ['Critical', 'High', 'Medium', 'Low'], default: 'Medium' },
  assignedTeam: { type: String, default: 'IT General' },
  aiReason: { type: String, default: '' },
  aiSuggestion: { type: String, default: '' },
  status: { type: String, enum: ['Open', 'In Progress', 'Resolved'], default: 'Open' },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.models.Ticket || mongoose.model<ITicket>('Ticket', TicketSchema);

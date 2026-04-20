import { Type } from "@google/genai";

export interface Transaction {
  id: string;
  amount: number;
  type: 'debit' | 'credit';
  paymentMethod: string;
  merchant: string;
  date: string; // ISO string
  category: string;
  expenseType: 'essential' | 'non-essential' | 'recurring' | 'investment';
  rawEmail?: string;
}

export interface SpendingSummary {
  dailyTotal: number;
  weeklyTotal: number;
  monthlyTotal: number;
  topCategory: string;
  topMerchant: string;
  weeklyComparison: number; // percentage change
}

export interface Insight {
  title: string;
  description: string;
  type: 'warning' | 'info' | 'success';
}

export const TRANSACTION_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      amount: { type: Type.NUMBER, description: "The transaction amount as a number" },
      type: { type: Type.STRING, enum: ["debit", "credit"], description: "Whether money went out (debit) or came in (credit)" },
      paymentMethod: { type: Type.STRING, description: "UPI, Credit Card, Debit Card, etc." },
      merchant: { type: Type.STRING, description: "Cleaned merchant name" },
      date: { type: Type.STRING, description: "ISO 8601 date and time string" },
      category: { type: Type.STRING, description: "food, groceries, transport, shopping, bills, entertainment, etc." },
      expenseType: { type: Type.STRING, enum: ["essential", "non-essential", "recurring", "investment"], description: "Classification of the expense" }
    },
    required: ["amount", "type", "paymentMethod", "merchant", "date", "category", "expenseType"]
  }
};

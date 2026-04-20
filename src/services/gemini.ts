import { GoogleGenAI } from "@google/genai";
import { Transaction, TRANSACTION_SCHEMA } from "../types";

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function parseEmails(emailBatch: string): Promise<Transaction[]> {
  const model = "gemini-3-flash-preview";
  
  const prompt = `
    Act as an automated personal finance tracking system for HDFC Bank transaction emails.
    
    STEP 1: FILTER EMAILS
    Identify which parts of the provided text are actual financial transactions. 
    Look for patterns like:
    - "debited for Rs."
    - "credited for Rs."
    - "spent on your HDFC Bank Credit Card"
    - "transaction on your HDFC Bank Debit Card"
    - "UPI transaction of Rs."
    - "HDFC Bank - Transaction Alert"
    
    Ignore OTPs, promotions, login alerts, or irrelevant alerts.
    
    STEP 2: EXTRACT & CLASSIFY
    From valid transactions, extract:
    - Amount (number)
    - Debit or credit
    - Payment method (UPI, Credit Card, Debit Card, NetBanking, etc.)
    - Merchant name (clean, simplified, e.g., "Zomato", "Amazon", "Starbucks")
    - Date and time (convert to ISO 8601)
    - Category (Food, Groceries, Transport, Shopping, Bills, Entertainment, etc.)
    - Expense Type (essential, non-essential, recurring, or investment)
    
    Input Text:
    """
    ${emailBatch}
    """
    
    Return the results as a JSON array of objects.
  `;

  try {
    const response = await genAI.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: TRANSACTION_SCHEMA
      }
    });

    const text = response.text;
    if (!text) return [];
    
    const parsed = JSON.parse(text);
    return parsed.map((t: any) => ({
      ...t,
      id: Math.random().toString(36).substring(2, 9) + Date.now()
    }));
  } catch (error) {
    console.error("Error parsing emails with Gemini:", error);
    return [];
  }
}

export async function generateSmartInsights(history: Transaction[]): Promise<string> {
  const model = "gemini-3-flash-preview";
  
  const prompt = `
    Analyze this transaction history and provide 3-4 short, clear, and actionable financial insights.
    Focus on patterns, overspending, unusual spikes, or frequent merchants.
    Keep them professional yet conversational, like a real finance app.
    
    History:
    ${JSON.stringify(history.slice(-50))}
    
    Return a plain text summary with bullet points.
  `;

  try {
    const response = await genAI.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }]
    });
    return response.text || "No insights available yet.";
  } catch (error) {
    console.error("Error generating insights:", error);
    return "Could not generate insights at this time.";
  }
}

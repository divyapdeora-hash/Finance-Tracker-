import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { google } from 'googleapis';
import cookieSession from 'cookie-session';
import dotenv from 'dotenv';

dotenv.config();

declare global {
  namespace Express {
    interface Request {
      session: {
        tokens?: any;
      } | null;
    }
  }
}

const app = express();
const PORT = 3000;

app.set('trust proxy', true); // Trust all proxies in Cloud Run environment
app.use(express.json());
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || 'finance-tracker-secret'],
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
  secure: true,
  sameSite: 'none',
  httpOnly: true,
  signed: true,
  overwrite: true
}));

// Log session state for debugging
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(`[${req.method}] ${req.path} - Session: ${!!req.session}, Tokens: ${!!req.session?.tokens}`);
  }
  next();
});

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${(process.env.APP_URL || '').replace(/\/$/, '')}/auth/callback`
);

// Listen for token refresh events to update the session
oauth2Client.on('tokens', (tokens) => {
  // Note: This is tricky with cookie-session as we don't have the req object here.
  // We'll handle refreshing manually in the sync route for better session persistence.
  console.log('New tokens received');
});

// Auth Routes
app.get('/api/auth/url', (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({ 
        error: 'Google OAuth credentials missing. Please add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your AI Studio Secrets.' 
      });
    }

    if (!process.env.APP_URL) {
      return res.status(500).json({ 
        error: 'APP_URL environment variable is missing. This is required for the redirect URI.' 
      });
    }

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/gmail.readonly'],
      prompt: 'consent'
    });
    res.json({ url });
  } catch (error: any) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ error: error.message || 'Failed to generate authentication URL' });
  }
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    console.log('Exchanging code for tokens...');
    const { tokens } = await oauth2Client.getToken(code as string);
    console.log('Tokens received successfully. Refresh token present:', !!tokens.refresh_token);
    
    // Strip id_token to keep session cookie small (4KB limit)
    const { id_token, ...safeTokens } = tokens;
    
    // Set in session for those who can use cookies
    if (req.session) {
      req.session.tokens = safeTokens;
    }
    
    const tokenJson = JSON.stringify(safeTokens);
    const base64Tokens = Buffer.from(tokenJson).toString('base64');
    
    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ 
                type: 'OAUTH_AUTH_SUCCESS', 
                tokens: "${base64Tokens}" 
              }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. You can close this window.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error getting tokens:', error);
    res.status(500).send('Authentication failed');
  }
});

// Middleware to extract tokens from header or session
const getTokens = (req: express.Request) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      return JSON.parse(Buffer.from(authHeader.substring(7), 'base64').toString());
    } catch (e) {
      return null;
    }
  }
  return req.session?.tokens;
};

app.get('/api/auth/status', (req, res) => {
  const tokens = getTokens(req);
  console.log('Auth status check. Tokens present:', !!tokens);
  res.json({ isAuthenticated: !!tokens });
});

app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

// Diagnostic Route
app.get('/api/diag', (req, res) => {
  const tokens = getTokens(req);
  res.json({
    hasClientId: !!process.env.GOOGLE_CLIENT_ID,
    hasClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
    hasAppUrl: !!process.env.APP_URL,
    appUrl: process.env.APP_URL,
    nodeEnv: process.env.NODE_ENV,
    isAuthenticated: !!tokens
  });
});

// Gmail API Route
app.get('/api/gmail/sync', async (req, res) => {
  const tokens = getTokens(req);
  
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Google OAuth credentials not configured in environment variables' });
  }

  console.log('Sync request received. Tokens present:', !!tokens);
  if (!tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    console.log('Starting Gmail sync for user...');
    oauth2Client.setCredentials(tokens);
    
    // Check if token is expired and refresh if necessary
    try {
      const { token } = await oauth2Client.getAccessToken();
      if (!token) {
        console.error('No access token returned from getAccessToken');
        throw new Error('Failed to obtain access token');
      }
      // Update session with potentially refreshed tokens if using cookies
      if (req.session) {
        req.session.tokens = oauth2Client.credentials;
      }
      console.log('Access token validated/refreshed');
    } catch (refreshError: any) {
      console.error('Token validation/refresh failed:', refreshError);
      // If refresh fails, it's a 401
      if (req.session) req.session = null;
      return res.status(401).json({ error: 'Authentication session invalid. Please reconnect Gmail.' });
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Search for HDFC transaction emails
    console.log('Searching for HDFC emails...');
    // Broadened query to catch more variants of HDFC alerts
    const q = '(from:hdfcbank.net OR from:hdfcbank.com OR from:alerts@hdfcbank.net OR "HDFC Bank" OR "HDFC BANK") AND ("debited" OR "credited" OR "spent" OR "transaction" OR "UPI" OR "VPA" OR "Rs." OR "INR")';
    console.log('Gmail search query:', q);
    const response = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 50 // Increased to catch more history
    });

    const messages = response.data.messages || [];

    // Helper to recursively extract body
    const getBody = (payload: any): string => {
      let body = '';
      if (payload.body?.data) {
        // Gmail uses base64url encoding
        const base64 = payload.body.data.replace(/-/g, '+').replace(/_/g, '/');
        body += Buffer.from(base64, 'base64').toString();
      }
      if (payload.parts) {
        payload.parts.forEach((part: any) => {
          body += getBody(part);
        });
      }
      return body;
    };
    
    // Fetch all messages in parallel to speed up sync and avoid timeouts
    const emailContents = await Promise.all(messages.map(async (message) => {
      try {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: message.id!,
          format: 'full'
        });

        const body = getBody(msg.data.payload);
        const subject = msg.data.payload.headers?.find(h => h.name === 'Subject')?.value || 'No Subject';
        const snippet = msg.data.snippet || '';
        
        console.log(`Found email: ${subject} (ID: ${message.id})`);
        
        if (body || snippet) {
          return {
            body: body || snippet,
            subject,
            snippet,
            id: message.id
          };
        }
      } catch (e) {
        console.error(`Error fetching message ${message.id}:`, e);
      }
      return null;
    }));

    const filteredContents = emailContents.filter(c => c !== null);

    console.log(`Sync complete. Found ${filteredContents.length} relevant emails.`);
    res.json({ emails: filteredContents });
  } catch (error: any) {
    console.error('Gmail sync error:', error);
    
    // Check for "API not enabled" error
    if (error.message?.includes('Gmail API has not been used') || error.message?.includes('disabled')) {
      const projectId = error.message.match(/project (\d+)/)?.[1] || '625552511095';
      const enableUrl = `https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=${projectId}`;
      return res.status(403).json({ 
        error: 'Gmail API is not enabled in your Google Cloud Project.',
        details: 'You must enable the Gmail API in the Google Cloud Console to use this feature.',
        link: enableUrl,
        isApiDisabled: true
      });
    }

    // Check for specific OAuth errors
    if (error.code === 401 || error.message?.includes('invalid_grant')) {
      if (req.session) req.session = null; // Clear invalid session
      return res.status(401).json({ error: 'Authentication expired. Please reconnect Gmail.' });
    }
    
    res.status(500).json({ error: error.message || 'Failed to sync with Gmail' });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

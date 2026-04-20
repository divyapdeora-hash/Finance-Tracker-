import React, { useState, useEffect, useMemo } from 'react';
import { 
  Plus, 
  History, 
  TrendingUp, 
  CreditCard, 
  PieChart, 
  AlertCircle, 
  CheckCircle2, 
  Loader2,
  ChevronRight,
  ArrowUpRight,
  ArrowDownRight,
  Wallet,
  Calendar,
  Filter,
  Mail,
  RefreshCw,
  LogOut,
  Settings,
  Clock,
  Save
} from 'lucide-react';
import { 
  format, 
  isToday, 
  isThisWeek, 
  isThisMonth, 
  subWeeks, 
  startOfWeek, 
  endOfWeek,
  parseISO
} from 'date-fns';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  Cell,
  AreaChart,
  Area
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { Toaster, toast } from 'sonner';
import { Transaction } from './types';
import { parseEmails, generateSmartInsights } from './services/gemini';
import { cn, formatCurrency } from './utils';

export default function App() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [emailInput, setEmailInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [insights, setInsights] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'dashboard' | 'history'>('dashboard');
  const [showInput, setShowInput] = useState(false);
  const [isGmailAuthenticated, setIsGmailAuthenticated] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [debugInfo, setDebugInfo] = useState<{ subjects: string[] } | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [syncInterval, setSyncInterval] = useState(4); // hours
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null);

  // Check Gmail Auth Status
  useEffect(() => {
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      const tokens = localStorage.getItem('gmail_tokens');
      const headers: Record<string, string> = {};
      if (tokens) headers['Authorization'] = `Bearer ${tokens}`;
      
      const res = await fetch('/api/auth/status', { 
        headers,
        credentials: 'include'
      });
      const data = await res.json();
      setIsGmailAuthenticated(data.isAuthenticated);
    } catch (e) {
      console.error("Auth check failed");
    }
  };

  const handleGmailConnect = async () => {
    try {
      const res = await fetch('/api/auth/url', { credentials: 'include' });
      if (!res.ok) {
        const errorData = await res.json();
        toast.error(errorData.error || "Failed to get authentication URL");
        return;
      }
      const { url } = await res.json();
      const authWindow = window.open(url, 'gmail_auth', 'width=600,height=700');
      
      const handleMessage = (event: MessageEvent) => {
        if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
          if (event.data.tokens) {
            localStorage.setItem('gmail_tokens', event.data.tokens);
          }
          checkAuthStatus(); // Re-verify with backend
          window.removeEventListener('message', handleMessage);
        }
      };
      window.addEventListener('message', handleMessage);
    } catch (e: any) {
      console.error("Failed to get auth URL:", e);
      toast.error("Network error", {
        description: "Could not reach the server. Please check your internet connection or try again later."
      });
    }
  };

  const handleGmailLogout = async () => {
    const tokens = localStorage.getItem('gmail_tokens');
    const headers: Record<string, string> = {};
    if (tokens) headers['Authorization'] = `Bearer ${tokens}`;
    
    await fetch('/api/auth/logout', { 
      method: 'POST', 
      headers,
      credentials: 'include'
    });
    localStorage.removeItem('gmail_tokens');
    setIsGmailAuthenticated(false);
  };

  const handleGmailSync = async () => {
    setIsSyncing(true);
    const syncToast = toast.loading("Checking your Gmail for HDFC alerts...");
    try {
      const tokens = localStorage.getItem('gmail_tokens');
      const headers: Record<string, string> = {};
      if (tokens) headers['Authorization'] = `Bearer ${tokens}`;

      const res = await fetch('/api/gmail/sync', { 
        headers,
        credentials: 'include'
      });
      
      let data;
      try {
        data = await res.json();
      } catch (jsonError) {
        throw new Error("Invalid response from server. The sync might have timed out.");
      }
      
      if (!res.ok) {
        if (res.status === 401) {
          setIsGmailAuthenticated(false);
          localStorage.removeItem('gmail_tokens');
          throw new Error(data.error || "Session expired. Please reconnect Gmail.");
        }
        if (res.status === 403 && data.isApiDisabled) {
          toast.error("Gmail API Not Enabled", {
            id: syncToast,
            description: "You need to enable the Gmail API in your Google Cloud Console.",
            action: {
              label: "Enable API",
              onClick: () => window.open(data.link, '_blank')
            }
          });
          return;
        }
        throw new Error(data.error || "Sync failed");
      }
      
      const { emails } = data;
      setDebugInfo({ subjects: emails.map((e: any) => e.subject) });
      
      if (emails.length > 0) {
        const batchText = emails.map((e: any) => `Subject: ${e.subject}\nSnippet: ${e.snippet}\nBody: ${e.body}`).join('\n---\n');
        const newTransactions = await parseEmails(batchText);
        
        if (newTransactions.length > 0) {
          setTransactions(prev => {
            const existingIds = new Set(prev.map(t => `${t.merchant}-${t.amount}-${t.date}`));
            const uniqueNew = newTransactions.filter(t => !existingIds.has(`${t.merchant}-${t.amount}-${t.date}`));
            
            if (uniqueNew.length > 0) {
              toast.success(`Found ${uniqueNew.length} new transaction(s)!`, { 
                id: syncToast,
                description: `Processed ${emails.length} HDFC emails.`
              });
            } else {
              toast.info("No new transactions found.", { 
                id: syncToast,
                description: `Found ${emails.length} HDFC emails, but they were already in your history.`
              });
              setShowDebug(true); // Auto-show debug if no new ones found but emails were present
            }

            return [...uniqueNew, ...prev].sort((a, b) => 
              new Date(b.date).getTime() - new Date(a.date).getTime()
            );
          });
        } else {
          toast.info("No transactions recognized.", { 
            id: syncToast,
            description: `Found ${emails.length} HDFC emails, but none matched transaction patterns.`
          });
          setShowDebug(true); // Auto-show debug to help user see what was found
        }
      } else {
        toast.info("No HDFC alerts found.", { 
          id: syncToast,
          description: "We couldn't find any HDFC transaction alerts in your inbox."
        });
        setShowDebug(true);
      }
      setLastSyncTime(Date.now());
    } catch (e: any) {
      console.error("Sync failed:", e);
      const isAuthError = e.message.includes('401') || e.message.includes('Session expired');
      
      if (isAuthError) {
        setIsGmailAuthenticated(false);
      }

      toast.error(isAuthError ? "Gmail session expired" : "Sync failed", { 
        id: syncToast,
        description: isAuthError 
          ? "Please reconnect your Gmail. If this persists, ensure third-party cookies are enabled in your browser settings."
          : (e.message === "Failed to fetch" 
              ? "Could not reach the server. This might be due to a timeout or network issue. Please try again." 
              : (e.message || "An unexpected error occurred during sync."))
      });
    } finally {
      setIsSyncing(false);
    }
  };

  // Load from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('hdfc_transactions');
    if (saved) {
      try {
        setTransactions(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse saved transactions");
      }
    }

    const savedSettings = localStorage.getItem('hdfc_settings');
    if (savedSettings) {
      try {
        const { interval, lastSync } = JSON.parse(savedSettings);
        setSyncInterval(interval || 4);
        setLastSyncTime(lastSync || null);
      } catch (e) {
        console.error("Failed to parse saved settings");
      }
    }
  }, []);

  // Save settings to localStorage
  useEffect(() => {
    localStorage.setItem('hdfc_settings', JSON.stringify({
      interval: syncInterval,
      lastSync: lastSyncTime
    }));
  }, [syncInterval, lastSyncTime]);

  // Automatic Sync Logic
  useEffect(() => {
    if (!isGmailAuthenticated || isSyncing) return;

    const checkAndSync = () => {
      const now = Date.now();
      const intervalMs = syncInterval * 60 * 60 * 1000;
      
      if (!lastSyncTime || (now - lastSyncTime) >= intervalMs) {
        console.log("Triggering automatic sync...");
        handleGmailSync();
      }
    };

    // Check on mount and every minute
    checkAndSync();
    const timer = setInterval(checkAndSync, 60000);
    return () => clearInterval(timer);
  }, [isGmailAuthenticated, syncInterval, lastSyncTime, isSyncing]);

  // Save to localStorage
  useEffect(() => {
    localStorage.setItem('hdfc_transactions', JSON.stringify(transactions));
    if (transactions.length > 0) {
      updateInsights();
    }
  }, [transactions]);

  const updateInsights = async () => {
    const newInsights = await generateSmartInsights(transactions);
    setInsights(newInsights);
  };

  const handleProcessEmails = async () => {
    if (!emailInput.trim()) return;
    
    setIsProcessing(true);
    const newTransactions = await parseEmails(emailInput);
    
    if (newTransactions.length > 0) {
      setTransactions(prev => [...newTransactions, ...prev].sort((a, b) => 
        new Date(b.date).getTime() - new Date(a.date).getTime()
      ));
      setEmailInput('');
      setShowInput(false);
    } else {
      alert("No new transactions found in this cycle.");
    }
    setIsProcessing(false);
  };

  const stats = useMemo(() => {
    const today = transactions.filter(t => isToday(parseISO(t.date)) && t.type === 'debit');
    const thisWeek = transactions.filter(t => isThisWeek(parseISO(t.date)) && t.type === 'debit');
    const thisMonth = transactions.filter(t => isThisMonth(parseISO(t.date)) && t.type === 'debit');
    
    const lastWeekStart = startOfWeek(subWeeks(new Date(), 1));
    const lastWeekEnd = endOfWeek(subWeeks(new Date(), 1));
    const lastWeek = transactions.filter(t => {
      const d = parseISO(t.date);
      return d >= lastWeekStart && d <= lastWeekEnd && t.type === 'debit';
    });

    const todayTotal = today.reduce((sum, t) => sum + t.amount, 0);
    const weekTotal = thisWeek.reduce((sum, t) => sum + t.amount, 0);
    const lastWeekTotal = lastWeek.reduce((sum, t) => sum + t.amount, 0);
    const monthTotal = thisMonth.reduce((sum, t) => sum + t.amount, 0);

    const weekDiff = lastWeekTotal === 0 ? 0 : ((weekTotal - lastWeekTotal) / lastWeekTotal) * 100;

    // Category breakdown
    const categories: Record<string, number> = {};
    thisMonth.forEach(t => {
      categories[t.category] = (categories[t.category] || 0) + t.amount;
    });
    
    const topCategory = Object.entries(categories).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';
    
    // Top merchant
    const merchants: Record<string, number> = {};
    thisMonth.forEach(t => {
      merchants[t.merchant] = (merchants[t.merchant] || 0) + t.amount;
    });
    const topMerchant = Object.entries(merchants).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

    return {
      todayTotal,
      weekTotal,
      monthTotal,
      weekDiff,
      topCategory,
      topMerchant,
      categoryData: Object.entries(categories).map(([name, value]) => ({ name, value }))
    };
  }, [transactions]);

  const chartData = useMemo(() => {
    const last7Days = Array.from({ length: 7 }).map((_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      const dateStr = format(d, 'MMM dd');
      const total = transactions
        .filter(t => format(parseISO(t.date), 'MMM dd') === dateStr && t.type === 'debit')
        .reduce((sum, t) => sum + t.amount, 0);
      return { name: dateStr, amount: total };
    });
    return last7Days;
  }, [transactions]);

  return (
    <div className="min-h-screen bg-[#F5F5F5] text-[#1A1A1A] font-sans selection:bg-emerald-100">
      {/* Debug Info */}
      <AnimatePresence>
        {showDebug && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 right-6 z-50 w-80 bg-white rounded-2xl shadow-2xl border border-black/5 p-4 overflow-hidden"
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <AlertCircle size={14} className="text-amber-500" />
                Sync Debugger
              </h3>
              <button onClick={() => setShowDebug(false)} className="text-neutral-400 hover:text-black">
                <Plus size={14} className="rotate-45" />
              </button>
            </div>
            <div className="space-y-2 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
              {!debugInfo ? (
                <p className="text-xs text-neutral-500 italic">No sync has been performed yet.</p>
              ) : (
                <>
                  <p className="text-[10px] uppercase tracking-widest text-neutral-400 font-bold">Emails Found ({debugInfo.subjects.length})</p>
                  {debugInfo.subjects.map((s, i) => (
                    <div key={i} className="text-xs p-2 bg-neutral-50 rounded-lg border border-black/5 truncate">
                      {s}
                    </div>
                  ))}
                  {debugInfo.subjects.length === 0 && (
                    <p className="text-xs text-neutral-500 italic">No HDFC emails found in your inbox.</p>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Toaster position="top-center" richColors />
      {/* Header */}
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-black/5 px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-200">
              <Wallet size={22} />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">HDFC Tracker</h1>
              <p className="text-[10px] uppercase tracking-widest text-neutral-400 font-medium">Automated Finance</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            {isGmailAuthenticated && (
              <button 
                onClick={() => setShowDebug(!showDebug)}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-xl transition-all text-sm font-medium",
                  showDebug 
                    ? "bg-amber-100 text-amber-700 shadow-sm" 
                    : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200"
                )}
                title="Debug Gmail Sync"
              >
                <AlertCircle size={16} className={showDebug ? "text-amber-600" : "text-neutral-400"} />
                <span className="hidden sm:inline">Debug Sync</span>
              </button>
            )}

            {isGmailAuthenticated ? (
              <div className="flex items-center gap-2 bg-emerald-50 p-1 rounded-xl border border-emerald-100">
                <button 
                  onClick={handleGmailSync}
                  disabled={isSyncing}
                  className="flex items-center gap-2 text-emerald-700 hover:bg-emerald-100 px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
                >
                  <RefreshCw size={16} className={cn(isSyncing && "animate-spin")} />
                  <span>{isSyncing ? "Syncing..." : "Sync Gmail"}</span>
                </button>
                <button 
                  onClick={() => setShowSettings(true)}
                  className="p-1.5 text-emerald-400 hover:text-emerald-600 hover:bg-emerald-100 rounded-lg transition-all"
                  title="Sync Settings"
                >
                  <Settings size={16} />
                </button>
                <button 
                  onClick={handleGmailLogout}
                  className="p-1.5 text-emerald-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                  title="Logout Gmail"
                >
                  <LogOut size={16} />
                </button>
              </div>
            ) : (
              <button 
                onClick={handleGmailConnect}
                className="flex items-center gap-2 bg-white border border-neutral-200 hover:border-emerald-500 text-neutral-700 px-4 py-2 rounded-xl text-sm font-medium transition-all shadow-sm"
              >
                <Mail size={18} className="text-emerald-600" />
                <span>Connect Gmail</span>
              </button>
            )}
            
            <nav className="hidden md:flex items-center bg-neutral-100 p-1 rounded-lg">
              <button 
                onClick={() => setActiveTab('dashboard')}
                className={cn(
                  "px-4 py-1.5 text-sm font-medium rounded-md transition-all",
                  activeTab === 'dashboard' ? "bg-white shadow-sm text-emerald-600" : "text-neutral-500 hover:text-neutral-800"
                )}
              >
                Dashboard
              </button>
              <button 
                onClick={() => setActiveTab('history')}
                className={cn(
                  "px-4 py-1.5 text-sm font-medium rounded-md transition-all",
                  activeTab === 'history' ? "bg-white shadow-sm text-emerald-600" : "text-neutral-500 hover:text-neutral-800"
                )}
              >
                History
              </button>
            </nav>
            
            <button 
              onClick={() => setShowInput(true)}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-all shadow-lg shadow-emerald-100 active:scale-95"
            >
              <Plus size={18} />
              <span>Process Emails</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {activeTab === 'dashboard' ? (
          <div className="space-y-8">
            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <StatCard 
                title="Today's Spend" 
                value={formatCurrency(stats.todayTotal)} 
                icon={<Calendar className="text-emerald-600" size={20} />}
                subtitle="Daily Summary"
              />
              <StatCard 
                title="Weekly Spend" 
                value={formatCurrency(stats.weekTotal)} 
                icon={<TrendingUp className="text-blue-600" size={20} />}
                trend={stats.weekDiff}
                subtitle="vs Last Week"
              />
              <StatCard 
                title="Monthly Spend" 
                value={formatCurrency(stats.monthTotal)} 
                icon={<PieChart className="text-purple-600" size={20} />}
                subtitle={`Top: ${stats.topCategory}`}
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              {/* Main Chart */}
              <div className="lg:col-span-2 bg-white p-6 rounded-3xl shadow-sm border border-black/5">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="font-semibold text-lg">Spending Trend</h3>
                  <div className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Last 7 Days</div>
                </div>
                <div className="h-[300px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id="colorAmount" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.1}/>
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                      <XAxis 
                        dataKey="name" 
                        axisLine={false} 
                        tickLine={false} 
                        tick={{ fontSize: 12, fill: '#999' }}
                        dy={10}
                      />
                      <YAxis 
                        axisLine={false} 
                        tickLine={false} 
                        tick={{ fontSize: 12, fill: '#999' }}
                        tickFormatter={(val) => `₹${val}`}
                      />
                      <Tooltip 
                        contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                        formatter={(val: number) => [formatCurrency(val), 'Spent']}
                      />
                      <Area 
                        type="monotone" 
                        dataKey="amount" 
                        stroke="#10b981" 
                        strokeWidth={3}
                        fillOpacity={1} 
                        fill="url(#colorAmount)" 
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Insights Panel */}
              <div className="bg-emerald-900 text-white p-6 rounded-3xl shadow-xl flex flex-col">
                <div className="flex items-center gap-2 mb-6">
                  <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center">
                    <TrendingUp size={18} />
                  </div>
                  <h3 className="font-semibold text-lg">Smart Insights</h3>
                </div>
                
                <div className="flex-1 overflow-auto space-y-4">
                  {insights ? (
                    <div className="prose prose-invert prose-sm max-w-none">
                      <div className="whitespace-pre-wrap text-emerald-50/80 leading-relaxed">
                        {insights}
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-center opacity-50">
                      <Loader2 className="animate-spin mb-2" />
                      <p className="text-sm">Analyzing your spending...</p>
                    </div>
                  )}
                </div>
                
                <div className="mt-6 pt-6 border-t border-white/10">
                  <div className="flex items-center justify-between text-xs font-medium text-emerald-300/60 uppercase tracking-widest">
                    <span>Top Merchant</span>
                    <span className="text-white">{stats.topMerchant}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Recent Transactions */}
            <div className="bg-white rounded-3xl shadow-sm border border-black/5 overflow-hidden">
              <div className="px-6 py-5 border-b border-black/5 flex items-center justify-between">
                <h3 className="font-semibold text-lg">Recent Transactions</h3>
                <button 
                  onClick={() => setActiveTab('history')}
                  className="text-sm font-medium text-emerald-600 hover:text-emerald-700 flex items-center gap-1"
                >
                  View All <ChevronRight size={16} />
                </button>
              </div>
              <div className="divide-y divide-black/5">
                {transactions.slice(0, 5).map((t) => (
                  <TransactionRow key={t.id} transaction={t} />
                ))}
                {transactions.length === 0 && (
                  <div className="p-12 text-center">
                    <History size={40} className="mx-auto mb-3 opacity-20 text-neutral-400" />
                    <p className="text-neutral-500 mb-6">No transactions yet. Sync your Gmail or paste emails to get started.</p>
                    
                    {isGmailAuthenticated ? (
                      <div className="flex flex-col items-center gap-3">
                        <button 
                          onClick={handleGmailSync}
                          disabled={isSyncing}
                          className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 rounded-2xl font-semibold shadow-lg shadow-emerald-100 transition-all active:scale-95 disabled:opacity-50"
                        >
                          <RefreshCw size={20} className={cn(isSyncing && "animate-spin")} />
                          <span>{isSyncing ? "Syncing Gmail..." : "Sync Gmail Now"}</span>
                        </button>
                        
                        <button 
                          onClick={() => setShowDebug(true)}
                          className="text-xs font-medium text-amber-600 hover:text-amber-700 flex items-center gap-1.5 bg-amber-50 px-3 py-1.5 rounded-lg border border-amber-100 transition-all"
                        >
                          <AlertCircle size={14} />
                          <span>Not seeing transactions? Open Debugger</span>
                        </button>
                      </div>
                    ) : (
                      <button 
                        onClick={handleGmailConnect}
                        className="inline-flex items-center gap-2 bg-white border-2 border-emerald-100 hover:border-emerald-500 text-emerald-700 px-6 py-3 rounded-2xl font-semibold transition-all shadow-sm active:scale-95"
                      >
                        <Mail size={20} className="text-emerald-600" />
                        <span>Connect Gmail to Auto-Sync</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-3xl shadow-sm border border-black/5 overflow-hidden">
            <div className="px-6 py-5 border-b border-black/5 flex items-center justify-between bg-neutral-50/50">
              <div className="flex items-center gap-4">
                <h3 className="font-semibold text-lg">Transaction History</h3>
                <span className="px-2 py-1 bg-neutral-200 text-neutral-600 rounded text-[10px] font-bold uppercase tracking-wider">
                  {transactions.length} Total
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button className="p-2 hover:bg-neutral-200 rounded-lg transition-colors text-neutral-500">
                  <Filter size={18} />
                </button>
              </div>
            </div>
            <div className="divide-y divide-black/5">
              {transactions.map((t) => (
                <TransactionRow key={t.id} transaction={t} />
              ))}
              {transactions.length === 0 && (
                <div className="p-24 text-center text-neutral-400">
                  <History size={48} className="mx-auto mb-4 opacity-20" />
                  <p className="text-lg">Your transaction history is empty</p>
                  <p className="text-sm mt-1">Add transactions by processing your bank emails</p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Email Input Modal */}
      <AnimatePresence>
        {showInput && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !isProcessing && setShowInput(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-2xl bg-white rounded-[32px] shadow-2xl overflow-hidden"
            >
              <div className="p-8">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h2 className="text-2xl font-bold tracking-tight">Process Emails</h2>
                    <p className="text-neutral-500 text-sm mt-1">Paste your HDFC Bank transaction emails here.</p>
                  </div>
                  <button 
                    onClick={() => setShowInput(false)}
                    className="p-2 hover:bg-neutral-100 rounded-full transition-colors"
                  >
                    <Plus className="rotate-45 text-neutral-400" size={24} />
                  </button>
                </div>

                <textarea
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="Example: HDFC Bank: Rs 500.00 debited from a/c **1234 on 23-MAR-26 to MERCHANT NAME..."
                  className="w-full h-64 p-4 bg-neutral-50 border border-neutral-200 rounded-2xl focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all resize-none font-mono text-sm"
                  disabled={isProcessing}
                />

                <div className="mt-6 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs text-neutral-400 font-medium uppercase tracking-wider">
                    <AlertCircle size={14} />
                    <span>Privacy: Data is processed locally</span>
                  </div>
                  <button
                    onClick={handleProcessEmails}
                    disabled={isProcessing || !emailInput.trim()}
                    className={cn(
                      "flex items-center gap-2 px-8 py-3 rounded-xl font-semibold transition-all shadow-lg active:scale-95",
                      isProcessing || !emailInput.trim() 
                        ? "bg-neutral-100 text-neutral-400 cursor-not-allowed shadow-none" 
                        : "bg-emerald-600 text-white hover:bg-emerald-700 shadow-emerald-100"
                    )}
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="animate-spin" size={20} />
                        <span>Processing...</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={20} />
                        <span>Analyze Batch</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSettings(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-[32px] shadow-2xl overflow-hidden"
            >
              <div className="p-8">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center text-emerald-600">
                      <Settings size={20} />
                    </div>
                    <h2 className="text-xl font-bold tracking-tight">Sync Settings</h2>
                  </div>
                  <button 
                    onClick={() => setShowSettings(false)}
                    className="p-2 hover:bg-neutral-100 rounded-full transition-colors"
                  >
                    <Plus className="rotate-45 text-neutral-400" size={24} />
                  </button>
                </div>

                <div className="space-y-6">
                  <div>
                    <label className="block text-sm font-semibold text-neutral-700 mb-2 flex items-center gap-2">
                      <Clock size={16} className="text-emerald-600" />
                      Fetch Interval (Hours)
                    </label>
                    <div className="flex items-center gap-4">
                      <input 
                        type="range" 
                        min="1" 
                        max="24" 
                        step="1"
                        value={syncInterval}
                        onChange={(e) => setSyncInterval(parseInt(e.target.value))}
                        className="flex-1 accent-emerald-600 h-2 bg-neutral-100 rounded-lg appearance-none cursor-pointer"
                      />
                      <span className="w-12 text-center font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-100">
                        {syncInterval}h
                      </span>
                    </div>
                    <p className="text-[10px] text-neutral-400 mt-2 uppercase tracking-wider font-bold">
                      The app will check for new emails every {syncInterval} hours while open.
                    </p>
                  </div>

                  <div className="p-4 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-neutral-500 font-medium">Last Sync</span>
                      <span className="font-bold text-neutral-700">
                        {lastSyncTime ? format(lastSyncTime, 'MMM dd, hh:mm a') : 'Never'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs mt-2">
                      <span className="text-neutral-500 font-medium">Next Scheduled Sync</span>
                      <span className="font-bold text-emerald-600">
                        {lastSyncTime ? format(lastSyncTime + (syncInterval * 60 * 60 * 1000), 'hh:mm a') : 'Now'}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={() => setShowSettings(false)}
                    className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-3 rounded-xl font-semibold hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100 active:scale-95"
                  >
                    <Save size={18} />
                    <span>Save Settings</span>
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

const StatCard: React.FC<{ 
  title: string; 
  value: string; 
  icon: React.ReactNode; 
  trend?: number;
  subtitle?: string;
}> = ({ title, value, icon, trend, subtitle }) => {
  return (
    <div className="bg-white p-6 rounded-3xl shadow-sm border border-black/5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="w-10 h-10 bg-neutral-50 rounded-xl flex items-center justify-center">
          {icon}
        </div>
        {trend !== undefined && trend !== 0 && (
          <div className={cn(
            "flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full",
            trend > 0 ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-600"
          )}>
            {trend > 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
            {Math.abs(trend).toFixed(1)}%
          </div>
        )}
      </div>
      <div>
        <p className="text-sm font-medium text-neutral-400 mb-1">{title}</p>
        <h4 className="text-2xl font-bold tracking-tight">{value}</h4>
        {subtitle && <p className="text-[10px] uppercase tracking-widest text-neutral-400 font-bold mt-2">{subtitle}</p>}
      </div>
    </div>
  );
};

interface TransactionRowProps {
  transaction: Transaction;
}

const TransactionRow: React.FC<TransactionRowProps> = ({ transaction }) => {
  const isDebit = transaction.type === 'debit';
  
  return (
    <div className="flex items-center justify-between px-6 py-4 hover:bg-neutral-50 transition-colors group">
      <div className="flex items-center gap-4">
        <div className={cn(
          "w-12 h-12 rounded-2xl flex items-center justify-center text-lg font-bold transition-transform group-hover:scale-110",
          isDebit ? "bg-neutral-100 text-neutral-600" : "bg-emerald-100 text-emerald-600"
        )}>
          {transaction.merchant.charAt(0).toUpperCase()}
        </div>
        <div>
          <h5 className="font-semibold text-neutral-900">{transaction.merchant}</h5>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-neutral-400">{format(parseISO(transaction.date), 'MMM dd, hh:mm a')}</span>
            <span className="w-1 h-1 bg-neutral-300 rounded-full" />
            <span className="text-[10px] uppercase tracking-wider font-bold text-neutral-400">{transaction.paymentMethod}</span>
          </div>
        </div>
      </div>
      <div className="text-right">
        <p className={cn(
          "font-bold text-lg tracking-tight",
          isDebit ? "text-neutral-900" : "text-emerald-600"
        )}>
          {isDebit ? '-' : '+'}{formatCurrency(transaction.amount)}
        </p>
        <div className="flex items-center justify-end gap-2 mt-1">
          <span className={cn(
            "text-[10px] uppercase tracking-widest font-bold px-2 py-0.5 rounded-md",
            transaction.expenseType === 'essential' ? "bg-blue-50 text-blue-600" :
            transaction.expenseType === 'recurring' ? "bg-purple-50 text-purple-600" :
            transaction.expenseType === 'investment' ? "bg-emerald-50 text-emerald-600" :
            "bg-neutral-100 text-neutral-500"
          )}>
            {transaction.expenseType}
          </span>
          <span className="text-[10px] uppercase tracking-widest font-bold text-neutral-300">
            {transaction.category}
          </span>
        </div>
      </div>
    </div>
  );
};

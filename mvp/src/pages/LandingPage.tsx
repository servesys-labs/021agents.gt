import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { Bot, Zap, ArrowRight, MessageSquare, Globe, Clock, Smartphone } from "lucide-react";

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gradient-to-b from-surface to-white">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 max-w-5xl mx-auto">
        <div className="flex items-center gap-2">
          <Bot size={24} className="text-primary" />
          <span className="text-lg font-bold text-text">OneShots</span>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/login")}>
            Log in
          </Button>
          <Button size="sm" onClick={() => navigate("/login?mode=signup")}>
            Try free
          </Button>
        </div>
      </nav>

      {/* Hero */}
      <section className="px-6 pt-16 pb-20 max-w-3xl mx-auto text-center">
        <h1 className="text-4xl sm:text-5xl font-bold text-text tracking-tight leading-tight">
          Your AI assistant that actually works
        </h1>
        <p className="text-lg text-text-secondary mt-4 max-w-xl mx-auto leading-relaxed">
          Answer customer questions, research anything, run code, analyze data — all from one assistant
          that works on WhatsApp, Telegram, Slack, and the web. $5 free credits to start.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-8">
          <Button onClick={() => navigate("/login?mode=signup")}>
            Get started free <ArrowRight size={16} />
          </Button>
          <Button variant="secondary" onClick={() => navigate("/explore")}>
            See what it can do
          </Button>
        </div>
      </section>

      {/* Social proof / outcomes */}
      <section className="px-6 py-12 bg-surface-alt/50">
        <div className="max-w-4xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-6 text-center">
          <div>
            <p className="text-2xl font-bold text-text">&lt;3s</p>
            <p className="text-xs text-text-secondary mt-1">Average response time</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-text">24/7</p>
            <p className="text-xs text-text-secondary mt-1">Always available</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-text">20+</p>
            <p className="text-xs text-text-secondary mt-1">Built-in tools</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-text">$5</p>
            <p className="text-xs text-text-secondary mt-1">Free to start</p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="px-6 py-16 max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold text-text text-center mb-10">Up and running in 60 seconds</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
          <div className="text-center">
            <div className="w-12 h-12 rounded-xl bg-primary-light flex items-center justify-center mx-auto mb-4">
              <MessageSquare size={24} className="text-primary" />
            </div>
            <h3 className="text-sm font-semibold text-text mb-2">1. Describe what you need</h3>
            <p className="text-sm text-text-secondary">
              Tell us about your business. AI designs your assistant with the right personality, knowledge, and tools.
            </p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 rounded-xl bg-primary-light flex items-center justify-center mx-auto mb-4">
              <Zap size={24} className="text-primary" />
            </div>
            <h3 className="text-sm font-semibold text-text mb-2">2. Test it instantly</h3>
            <p className="text-sm text-text-secondary">
              Chat with your assistant right away. It can search the web, run code, analyze files, and answer questions.
            </p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 rounded-xl bg-primary-light flex items-center justify-center mx-auto mb-4">
              <Smartphone size={24} className="text-primary" />
            </div>
            <h3 className="text-sm font-semibold text-text mb-2">3. Connect your channels</h3>
            <p className="text-sm text-text-secondary">
              Add it to WhatsApp, Telegram, Slack, or embed on your website. Your customers talk to it directly.
            </p>
          </div>
        </div>
      </section>

      {/* What it can do */}
      <section className="px-6 py-16 max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold text-text text-center mb-10">One assistant, everything you need</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div className="p-6 rounded-xl border border-border bg-white">
            <Globe size={20} className="text-primary mb-3" />
            <h3 className="text-sm font-semibold text-text mb-1">Web search and research</h3>
            <p className="text-sm text-text-secondary">
              Searches the internet for real-time answers. Finds prices, reads articles, checks competitors — no copy-pasting.
            </p>
          </div>
          <div className="p-6 rounded-xl border border-border bg-white">
            <Zap size={20} className="text-primary mb-3" />
            <h3 className="text-sm font-semibold text-text mb-1">Code and data analysis</h3>
            <p className="text-sm text-text-secondary">
              Runs Python, analyzes spreadsheets, makes charts, processes files. Like having a data analyst on call.
            </p>
          </div>
          <div className="p-6 rounded-xl border border-border bg-white">
            <MessageSquare size={20} className="text-primary mb-3" />
            <h3 className="text-sm font-semibold text-text mb-1">Customer support 24/7</h3>
            <p className="text-sm text-text-secondary">
              Answers FAQs, takes messages, qualifies leads. Works while you sleep, on every channel your customers use.
            </p>
          </div>
          <div className="p-6 rounded-xl border border-border bg-white">
            <Clock size={20} className="text-primary mb-3" />
            <h3 className="text-sm font-semibold text-text mb-1">Remembers everything</h3>
            <p className="text-sm text-text-secondary">
              Persistent memory across conversations. Learns your preferences, remembers past requests, gets better over time.
            </p>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="px-6 py-16 bg-surface-alt/50">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-2xl font-bold text-text mb-4">Pay only for what you use</h2>
          <p className="text-sm text-text-secondary mb-8">
            No monthly subscription. No hidden fees. Start with $5 free credits — that's enough for hundreds of conversations.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-5 rounded-xl border border-border bg-white text-center">
              <p className="text-lg font-bold text-text">$10</p>
              <p className="text-xs text-text-secondary mt-1">Starter — 1,000+ messages</p>
            </div>
            <div className="p-5 rounded-xl border-2 border-primary bg-white text-center relative">
              <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-primary text-white text-[10px] font-medium px-2 py-0.5 rounded-full">Popular</span>
              <p className="text-lg font-bold text-text">$50</p>
              <p className="text-xs text-text-secondary mt-1">Growth — 5,500+ messages</p>
              <p className="text-[10px] text-success mt-1">+10% bonus credits</p>
            </div>
            <div className="p-5 rounded-xl border border-border bg-white text-center">
              <p className="text-lg font-bold text-text">$100</p>
              <p className="text-xs text-text-secondary mt-1">Scale — 12,000+ messages</p>
              <p className="text-[10px] text-success mt-1">+20% bonus credits</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-6 py-16 text-center">
        <h2 className="text-2xl font-bold text-text mb-4">Ready to try it?</h2>
        <p className="text-sm text-text-secondary mb-6 max-w-md mx-auto">
          Create your assistant in 60 seconds. No credit card required. $5 free credits included.
        </p>
        <Button onClick={() => navigate("/login?mode=signup")}>
          Get started free <ArrowRight size={16} />
        </Button>
      </section>

      {/* Footer */}
      <footer className="px-6 py-8 border-t border-border text-center">
        <p className="text-xs text-text-muted">
          OneShots — AI assistants for your business and beyond.
        </p>
      </footer>
    </div>
  );
}

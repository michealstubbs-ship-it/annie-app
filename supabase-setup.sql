-- Annie App — Database Setup
-- Run this entire file in Supabase SQL Editor

-- Profiles (extends auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email TEXT,
  full_name TEXT,
  firm_name TEXT,
  job_title TEXT,
  phone TEXT,
  onboarding_completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Onboarding responses
CREATE TABLE IF NOT EXISTS onboarding (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  firm_name TEXT,
  sectors TEXT[],
  locations TEXT[],
  target_companies TEXT[],
  bd_goals TEXT,
  tone TEXT DEFAULT 'professional',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Contacts
CREATE TABLE IF NOT EXISTS contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  title TEXT,
  linkedin_url TEXT,
  status TEXT DEFAULT 'warm',
  notes TEXT,
  last_contacted TIMESTAMPTZ,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- BD Pipeline / Deals
CREATE TABLE IF NOT EXISTS deals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  company TEXT NOT NULL,
  role TEXT,
  stage TEXT DEFAULT 'prospect',
  value NUMERIC DEFAULT 0,
  probability INTEGER DEFAULT 25,
  notes TEXT,
  next_action TEXT,
  next_action_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Signals / Triggers
CREATE TABLE IF NOT EXISTS signals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'other',
  title TEXT NOT NULL,
  description TEXT,
  company TEXT,
  is_actioned BOOLEAN DEFAULT FALSE,
  actioned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Today's Actions cache
CREATE TABLE IF NOT EXISTS actions_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  actions JSONB NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
);

-- Enable Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE actions_cache ENABLE ROW LEVEL SECURITY;

-- RLS Policies — users see ONLY their own data
CREATE POLICY "Own profile only" ON profiles FOR ALL USING (auth.uid() = id);
CREATE POLICY "Own onboarding only" ON onboarding FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Own contacts only" ON contacts FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Own deals only" ON deals FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Own signals only" ON signals FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Own chat only" ON chat_messages FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Own cache only" ON actions_cache FOR ALL USING (auth.uid() = user_id);

-- Auto-create profile when user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, firm_name)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'firm_name'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

create extension if not exists vector;

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  handle text unique not null,
  display_name text not null,
  avatar_url text,
  system_prompt text not null,
  memory_instructions text,
  public_config jsonb default '{}',
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.fans (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  username text unique,
  created_at timestamptz default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents(id) on delete cascade,
  fan_id uuid references public.fans(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  tier text not null check (tier in ('free','basic','premium','ultra')),
  status text not null default 'inactive',
  current_period_end timestamptz,
  created_at timestamptz default now()
);
create index on public.subscriptions(agent_id, fan_id);

create table if not exists public.entitlements (
  agent_id uuid references public.agents(id) on delete cascade,
  fan_id uuid references public.fans(id) on delete cascade,
  feature text not null,
  value text not null,
  primary key (agent_id, fan_id, feature)
);

create table if not exists public.messages (
  id bigserial primary key,
  agent_id uuid references public.agents(id) on delete cascade,
  fan_id uuid references public.fans(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  meta jsonb default '{}',
  created_at timestamptz default now()
);
create index on public.messages(agent_id, fan_id, created_at);

create table if not exists public.memories (
  id bigserial primary key,
  agent_id uuid references public.agents(id) on delete cascade,
  fan_id uuid references public.fans(id) on delete cascade,
  label text,
  text text not null,
  embedding vector(1536),
  importance smallint default 1,
  tags text[] default '{}',
  created_at timestamptz default now()
);
create index on public.memories(agent_id, fan_id);
create index on public.memories using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create table if not exists public.analytics_events (
  id bigserial primary key,
  agent_id uuid,
  fan_id uuid,
  name text not null,
  value numeric,
  meta jsonb default '{}',
  occurred_at timestamptz default now()
);
create index on public.analytics_events(agent_id, name, occurred_at);

alter table public.messages enable row level security;
alter table public.memories enable row level security;
alter table public.subscriptions enable row level security;
alter table public.entitlements enable row level security;

create policy "messages_read_own" on public.messages
  for select using (
    auth.uid() is not null and exists (
      select 1 from public.fans f where f.auth_user_id = auth.uid() and f.id = messages.fan_id
    )
  );

create policy "messages_insert_self" on public.messages
  for insert with check (
    auth.uid() is not null and exists (
      select 1 from public.fans f where f.auth_user_id = auth.uid() and f.id = messages.fan_id
    )
  );

create policy "memories_read_scoped" on public.memories
  for select using (
    auth.uid() is not null and exists (
      select 1 from public.fans f where f.auth_user_id = auth.uid() and f.id = memories.fan_id
    )
  );

create policy "memories_write_scoped" on public.memories
  for insert with check (
    auth.uid() is not null and exists (
      select 1 from public.fans f where f.auth_user_id = auth.uid() and f.id = memories.fan_id
    )
  );
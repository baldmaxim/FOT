-- Блокируем партиции skud_events от прямого доступа через PostgREST (anon/authenticated)
-- Бэкенд ходит через service role и этим правилам не подчиняется.
-- Advisor закрывает: sensitive_columns_exposed × 18 (skud_events_* партиции).

ALTER TABLE public.skud_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events FROM anon, authenticated;

ALTER TABLE public.skud_events_2026_01 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2026_01 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2026_01 FROM anon, authenticated;

ALTER TABLE public.skud_events_2026_02 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2026_02 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2026_02 FROM anon, authenticated;

ALTER TABLE public.skud_events_2026_03 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2026_03 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2026_03 FROM anon, authenticated;

ALTER TABLE public.skud_events_2026_04 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2026_04 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2026_04 FROM anon, authenticated;

ALTER TABLE public.skud_events_2026_05 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2026_05 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2026_05 FROM anon, authenticated;

ALTER TABLE public.skud_events_2026_06 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2026_06 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2026_06 FROM anon, authenticated;

ALTER TABLE public.skud_events_2026_07 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2026_07 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2026_07 FROM anon, authenticated;

ALTER TABLE public.skud_events_2026_08 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2026_08 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2026_08 FROM anon, authenticated;

ALTER TABLE public.skud_events_2026_09 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2026_09 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2026_09 FROM anon, authenticated;

ALTER TABLE public.skud_events_2026_10 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2026_10 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2026_10 FROM anon, authenticated;

ALTER TABLE public.skud_events_2026_11 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2026_11 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2026_11 FROM anon, authenticated;

ALTER TABLE public.skud_events_2026_12 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2026_12 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2026_12 FROM anon, authenticated;

ALTER TABLE public.skud_events_2027_q1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2027_q1 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2027_q1 FROM anon, authenticated;

ALTER TABLE public.skud_events_2027_q2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2027_q2 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2027_q2 FROM anon, authenticated;

ALTER TABLE public.skud_events_2027_q3 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2027_q3 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2027_q3 FROM anon, authenticated;

ALTER TABLE public.skud_events_2027_q4 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2027_q4 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2027_q4 FROM anon, authenticated;

ALTER TABLE public.skud_events_2028_h1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2028_h1 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2028_h1 FROM anon, authenticated;

ALTER TABLE public.skud_events_2028_h2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_events_2028_h2 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_events_2028_h2 FROM anon, authenticated;

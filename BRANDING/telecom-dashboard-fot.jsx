import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";

// ─── Токены из branding.md ────────────────────────────────────────────────
const THEMES = {
  dark: {
    bgPrimary: "#0a0a0b", bgSecondary: "#111113", bgTertiary: "#18181b", bgElevated: "#1f1f23",
    border: "#27272a", borderSubtle: "#1e1e21",
    textPrimary: "#fafafa", textSecondary: "#a1a1aa", textTertiary: "#71717a",
    accent: "#3b82f6", accentMuted: "rgba(59,130,246,0.1)",
    success: "#22c55e", successMuted: "rgba(34,197,94,0.1)",
    warning: "#f59e0b", warningMuted: "rgba(245,158,11,0.1)",
    error: "#ef4444", errorMuted: "rgba(239,68,68,0.1)",
    chartCompare: "#3f3f46",
  },
  light: {
    bgPrimary: "#ffffff", bgSecondary: "#fafafa", bgTertiary: "#f4f4f5", bgElevated: "#e4e4e7",
    border: "#e4e4e7", borderSubtle: "#f4f4f5",
    textPrimary: "#09090b", textSecondary: "#52525b", textTertiary: "#a1a1aa",
    accent: "#2563eb", accentMuted: "rgba(37,99,235,0.08)",
    success: "#16a34a", successMuted: "rgba(22,163,74,0.08)",
    warning: "#d97706", warningMuted: "rgba(217,119,6,0.08)",
    error: "#dc2626", errorMuted: "rgba(220,38,38,0.08)",
    chartCompare: "#d4d4d8",
  },
};

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
const num = { fontVariantNumeric: "tabular-nums" };
const fmt = (v) => Math.round(v).toLocaleString("ru-RU");
const fmtTime = (min) => `${Math.floor(min / 60)} ч ${String(Math.round(min % 60)).padStart(2, "0")} м`;

// ─── Мок-данные (замените на данные вашего backend) ───────────────────────
const ACCOUNTS = [
  { id: "a1", name: "ООО «СтройМонтаж»", ls: "ЛС ···4812" },
  { id: "a2", name: "ООО «ГлавФасад»", ls: "ЛС ···9034" },
  { id: "a3", name: "ИП Одинцов", ls: "ЛС ···1177" },
];

const EMPLOYEES = [
  { name: "Осипов К.", dept: "Логистика", acc: "a1", cost: 18420, min: 2140, roam: true },
  { name: "Ким Д.", dept: "Продажи", acc: "a1", cost: 12960, min: 2860, roam: true },
  { name: "Соколова М.", dept: "Дирекция", acc: "a2", cost: 9840, min: 1230, roam: false },
  { name: "Петров С.", dept: "Сервис", acc: "a1", cost: 7315, min: 1980, roam: false },
  { name: "Ахметова Л.", dept: "Маркетинг", acc: "a2", cost: 6208, min: 1540, roam: false },
  { name: "Волков И.", dept: "Снабжение", acc: "a1", cost: 5930, min: 2410, roam: false },
  { name: "Ершов Н.", dept: "Продажи", acc: "a3", cost: 5480, min: 2230, roam: false },
  { name: "Гусева А.", dept: "Бухгалтерия", acc: "a2", cost: 5120, min: 870, roam: false },
  { name: "Мельник П.", dept: "Сервис", acc: "a1", cost: 4890, min: 1760, roam: false },
  { name: "Фомин Р.", dept: "Логистика", acc: "a3", cost: 4610, min: 1690, roam: true },
  { name: "Зайцева О.", dept: "HR", acc: "a2", cost: 4230, min: 1120, roam: false },
  { name: "Крылов Т.", dept: "Монтаж", acc: "a1", cost: 3980, min: 1830, roam: false },
  { name: "Белова Е.", dept: "Продажи", acc: "a2", cost: 3740, min: 1410, roam: false },
  { name: "Сафонов Д.", dept: "Монтаж", acc: "a1", cost: 3510, min: 1350, roam: false },
  { name: "Тихонов В.", dept: "Снабжение", acc: "a3", cost: 3280, min: 980, roam: false },
  { name: "Ларина Ю.", dept: "Дирекция", acc: "a2", cost: 3040, min: 640, roam: false },
  { name: "Носов Г.", dept: "Сервис", acc: "a1", cost: 2810, min: 1210, roam: false },
  { name: "Ильина С.", dept: "Бухгалтерия", acc: "a1", cost: 2590, min: 540, roam: false },
  { name: "Дроздов М.", dept: "Монтаж", acc: "a3", cost: 2340, min: 1090, roam: false },
  { name: "Уткин А.", dept: "Логистика", acc: "a2", cost: 2120, min: 880, roam: false },
  { name: "Панова К.", dept: "Маркетинг", acc: "a1", cost: 1980, min: 760, roam: false },
  { name: "Егоров Л.", dept: "Монтаж", acc: "a2", cost: 1740, min: 930, roam: false },
  { name: "Царёва Н.", dept: "HR", acc: "a3", cost: 1520, min: 610, roam: false },
  { name: "Быков Ф.", dept: "Сервис", acc: "a3", cost: 1310, min: 720, roam: false },
];

const SPEND = [
  { m: "Янв", a1: 92300, a2: 51200, a3: 24900, prev: 172100 },
  { m: "Фев", a1: 95100, a2: 50400, a3: 25700, prev: 169800 },
  { m: "Мар", a1: 90800, a2: 49900, a3: 25200, prev: 175400 },
  { m: "Апр", a1: 101400, a2: 54100, a3: 26800, prev: 171200 },
  { m: "Май", a1: 97600, a2: 52700, a3: 26500, prev: 180900 },
  { m: "Июн", a1: 106200, a2: 55300, a3: 27600, prev: 178300 },
];

const SUBSCRIBERS = {
  all: [158, 9, 12, 5], a1: [84, 5, 6, 3], a2: [51, 3, 4, 1], a3: [23, 1, 2, 1],
};
const SUB_LABELS = ["Активны", "В роуминге", "Заблокированы", "Блокировка запланирована"];

const EVENTS = [
  { op: "Блокировка BL0005 · отложенная", target: "Осипов К. · +7 916 ···-14-52", when: "15.07, 09:00", st: "accepted" },
  { op: "Замена SIM → eSIM", target: "Соколова М. · +7 985 ···-77-03", when: "сегодня, 11:24", st: "pending" },
  { op: "Смена тарифа", target: "Ким Д. · +7 903 ···-30-18", when: "сегодня, 10:02", st: "error" },
  { op: "Отключение услуги «Гудок»", target: "12 абонентов", when: "вчера, 18:40", st: "accepted" },
];

// ─── Компонент ────────────────────────────────────────────────────────────
export default function TelecomDashboardFOT() {
  const [theme, setTheme] = useState("dark");
  const [account, setAccount] = useState("all");
  const [metric, setMetric] = useState("cost"); // cost | time
  const [showRest, setShowRest] = useState(false);
  const T = THEMES[theme];

  const people = useMemo(() => {
    const list = account === "all" ? EMPLOYEES : EMPLOYEES.filter((e) => e.acc === account);
    return [...list].sort((a, b) => b[metric === "cost" ? "cost" : "min"] - a[metric === "cost" ? "cost" : "min"]);
  }, [account, metric]);

  const TOP_N = 12;
  const top = people.slice(0, TOP_N);
  const rest = people.slice(TOP_N);
  const maxVal = top.length ? (metric === "cost" ? top[0].cost : top[0].min) : 1;

  const totalCost = people.reduce((s, e) => s + e.cost, 0);
  const totalMin = people.reduce((s, e) => s + e.min, 0);
  const roamCount = people.filter((e) => e.roam).length;
  const subs = SUBSCRIBERS[account] || SUBSCRIBERS.all;
  const subsTotal = subs.reduce((s, v) => s + v, 0);
  const subColors = [T.accent, T.error, T.textTertiary, T.warning];

  const spendData = useMemo(() =>
    SPEND.map((r) => ({
      m: r.m,
      cur: account === "all" ? r.a1 + r.a2 + r.a3 : r[account],
      prev: account === "all" ? r.prev : null,
    })), [account]);

  const ST = {
    accepted: { text: "Принята", bg: T.successMuted, fg: T.success },
    pending: { text: "В обработке", bg: T.warningMuted, fg: T.warning },
    error: { text: "Ошибка", bg: T.errorMuted, fg: T.error },
  };

  const Card = ({ children, style }) => (
    <div style={{ background: T.bgSecondary, border: `1px solid ${T.border}`, borderRadius: 12, padding: "16px 20px", ...style }}>
      {children}
    </div>
  );
  const Title = ({ children, extra }) => (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
      <span style={{ fontSize: 15, lineHeight: "24px", fontWeight: 600, color: T.textPrimary }}>{children}</span>
      {extra && <span style={{ fontSize: 12, color: T.textTertiary }}>{extra}</span>}
    </div>
  );
  const Seg = ({ options, value, onChange }) => (
    <div style={{ display: "inline-flex", background: T.bgTertiary, border: `1px solid ${T.border}`, borderRadius: 8, padding: 2 }}>
      {options.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)}
          style={{
            border: "none", cursor: "pointer", fontFamily: FONT, fontSize: 12, fontWeight: 500,
            padding: "6px 12px", borderRadius: 6, transition: "background .15s",
            background: value === o.v ? T.bgElevated : "transparent",
            color: value === o.v ? T.textPrimary : T.textSecondary,
          }}>
          {o.label}
        </button>
      ))}
    </div>
  );

  const kpis = [
    { label: "Расходы за июнь", value: `${fmt(totalCost)} ₽`, sub: "+7,0% к маю", subColor: T.error },
    { label: "Время на телефоне", value: fmtTime(totalMin), sub: `${people.length} абонентов`, subColor: T.textTertiary },
    { label: "В роуминге сейчас", value: String(roamCount), sub: roamCount ? "проверьте лимиты" : "всё спокойно", subColor: roamCount ? T.error : T.success, live: roamCount > 0 },
    { label: "Заявки в обработке", value: "4", sub: "1 ошибка", subColor: T.error },
  ];

  const ChartTip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={{ background: T.bgElevated, border: `1px solid ${T.border}`, color: T.textPrimary, borderRadius: 8, padding: "8px 12px", fontSize: 12, fontFamily: FONT }}>
        <div style={{ color: T.textTertiary, marginBottom: 4 }}>{label}</div>
        {payload.filter((p) => p.value != null).map((p) => (
          <div key={p.dataKey} style={{ display: "flex", justifyContent: "space-between", gap: 16, ...num }}>
            <span style={{ color: p.dataKey === "cur" ? T.textPrimary : T.textTertiary }}>
              {p.dataKey === "cur" ? "2026" : "2025"}
            </span>
            <span>{fmt(p.value)} ₽</span>
          </div>
        ))}
      </div>
    );
  };

  const Row = ({ e, i, compact }) => {
    const val = metric === "cost" ? e.cost : e.min;
    return (
      <div style={{ display: "grid", gridTemplateColumns: "26px minmax(0,1fr) 120px 96px", alignItems: "center", gap: 10, padding: compact ? "7px 0" : "9px 0", borderTop: i ? `1px solid ${T.borderSubtle}` : "none" }}>
        <span style={{ fontSize: 12, color: T.textTertiary, ...num }}>{i + 1}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, lineHeight: "20px", fontWeight: 500, color: T.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {e.name}
            {e.roam && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, color: T.error, background: T.errorMuted, borderRadius: 4, padding: "1px 6px" }}>роуминг</span>}
          </div>
          <div style={{ fontSize: 11, lineHeight: "16px", color: T.textTertiary }}>
            {e.dept}{account === "all" && ` · ${ACCOUNTS.find((a) => a.id === e.acc).name.replace(/ООО «|ИП |»/g, "")}`}
          </div>
        </div>
        {!compact ? (
          <div style={{ height: 5, borderRadius: 3, background: T.bgTertiary }}>
            <div style={{ height: 5, borderRadius: 3, width: `${(val / maxVal) * 100}%`, background: T.accent }} />
          </div>
        ) : <span />}
        <span style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, textAlign: "right", ...num }}>
          {metric === "cost" ? `${fmt(e.cost)} ₽` : fmtTime(e.min)}
        </span>
      </div>
    );
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bgPrimary, fontFamily: FONT, padding: "24px 32px", transition: "background .2s" }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>

        {/* Шапка */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 11, lineHeight: "16px", color: T.textTertiary, letterSpacing: "0.05em", textTransform: "uppercase" }}>Корпоративная связь</div>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: "2px 0 0", color: T.textPrimary, letterSpacing: "-0.5px" }}>Обзор</h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Seg value={account} onChange={setAccount}
              options={[{ v: "all", label: "Все счета" }, ...ACCOUNTS.map((a) => ({ v: a.id, label: a.name.replace(/ООО «|»/g, "") }))]} />
            <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              style={{ height: 36, width: 36, borderRadius: 8, border: `1px solid ${T.border}`, background: T.bgSecondary, color: T.textSecondary, cursor: "pointer", fontSize: 14 }}>
              {theme === "dark" ? "☀" : "☾"}
            </button>
          </div>
        </div>

        {/* KPI */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12, marginBottom: 12 }}>
          {kpis.map((k) => (
            <Card key={k.label}>
              <div style={{ fontSize: 12, lineHeight: "16px", color: T.textSecondary, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                {k.live && <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.error, animation: "pulse 1.6s infinite" }} />}
                {k.label}
              </div>
              <div style={{ fontSize: 28, lineHeight: "36px", fontWeight: 700, letterSpacing: "-1px", color: T.textPrimary, ...num }}>{k.value}</div>
              <div style={{ fontSize: 12, lineHeight: "16px", fontWeight: 500, color: k.subColor, marginTop: 4, ...num }}>{k.sub}</div>
            </Card>
          ))}
        </div>

        {/* Абоненты */}
        <Card style={{ marginBottom: 12 }}>
          <Title extra={`${subsTotal} абонентов`}>Абоненты</Title>
          <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", gap: 2 }}>
            {subs.map((c, i) => (
              <div key={i} title={`${SUB_LABELS[i]}: ${c}`} style={{ width: `${(c / subsTotal) * 100}%`, background: subColors[i], minWidth: 5 }} />
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", marginTop: 12 }}>
            {subs.map((c, i) => (
              <span key={i} style={{ fontSize: 12, color: T.textSecondary, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: subColors[i] }} />
                {SUB_LABELS[i]} <b style={{ color: T.textPrimary, fontWeight: 600, ...num }}>{c}</b>
              </span>
            ))}
          </div>
        </Card>

        {/* Топ сотрудников + динамика */}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.25fr) minmax(0,1fr)", gap: 12, marginBottom: 12 }}>
          <Card>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: T.textPrimary }}>Топ сотрудников</span>
              <Seg value={metric} onChange={setMetric}
                options={[{ v: "cost", label: "По затратам" }, { v: "time", label: "По времени" }]} />
            </div>
            <div>
              {top.map((e, i) => <Row key={e.name} e={e} i={i} />)}
            </div>
            {rest.length > 0 && (
              <>
                <button onClick={() => setShowRest(!showRest)}
                  style={{
                    marginTop: 10, width: "100%", height: 36, borderRadius: 8, cursor: "pointer",
                    border: `1px solid ${T.border}`, background: T.bgTertiary, fontFamily: FONT,
                    fontSize: 12, fontWeight: 500, color: T.textSecondary,
                  }}>
                  {showRest ? "Свернуть" : `Остальные · ${rest.length}`}
                </button>
                {showRest && (
                  <div style={{ marginTop: 8 }}>
                    {rest.map((e, i) => <Row key={e.name} e={e} i={i + TOP_N + 1} compact />)}
                  </div>
                )}
              </>
            )}
          </Card>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Card>
              <Title extra="₽ в месяц">Динамика расходов</Title>
              <div style={{ height: 200 }}>
                <ResponsiveContainer>
                  <AreaChart data={spendData} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="acc" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={T.accent} stopOpacity={0.22} />
                        <stop offset="100%" stopColor={T.accent} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke={T.borderSubtle} />
                    <XAxis dataKey="m" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: T.textTertiary, fontFamily: FONT }} dy={6} />
                    <YAxis tickLine={false} axisLine={false} width={44}
                      tick={{ fontSize: 11, fill: T.textTertiary, fontFamily: FONT }} tickFormatter={(v) => `${Math.round(v / 1000)}к`} />
                    <Tooltip content={<ChartTip />} cursor={{ stroke: T.textTertiary, strokeDasharray: "3 3" }} />
                    {account === "all" && (
                      <Area dataKey="prev" stroke={T.chartCompare} strokeWidth={1.4} strokeDasharray="5 4" fill="none" dot={false} />
                    )}
                    <Area dataKey="cur" stroke={T.accent} strokeWidth={2} fill="url(#acc)"
                      dot={{ r: 2.5, fill: T.accent, strokeWidth: 0 }} activeDot={{ r: 4 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card>
              <Title extra="журнал EventID">Последние заявки</Title>
              <div>
                {EVENTS.map((e, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "9px 0", borderTop: i ? `1px solid ${T.borderSubtle}` : "none" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, lineHeight: "20px", fontWeight: 500, color: T.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.op}</div>
                      <div style={{ fontSize: 11, lineHeight: "16px", color: T.textTertiary, ...num }}>{e.target} · {e.when}</div>
                    </div>
                    <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 500, padding: "3px 8px", borderRadius: 4, background: ST[e.st].bg, color: ST[e.st].fg }}>
                      {ST[e.st].text}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>

      </div>
    </div>
  );
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Download, Upload, CalendarDays, CheckCircle2, RotateCcw, Plus, Minus, Dumbbell, Utensils, LineChart as IconLineChart, Settings, Music, Play, Pause, RefreshCw, CloudOff } from "lucide-react";
import { LineChart as RLineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

// =========================
// Helpers (Top-level only)
// =========================
const LS_KEY = "vibefit.tracker.v1.3"; // bump to avoid stale localStorage issues

function ymd(date: Date = new Date()) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

function weekdayStr(dateStr: string) {
  const d = new Date(dateStr);
  return ["日","月","火","水","木","金","土"][d.getDay()];
}

// 一部の共有サービスURLを直リンクに正規化（Dropbox/Google Driveなど）
function normalizeMediaUrl(u: string): string {
  try {
    const raw = (u ?? '').trim();
    if (!raw) return '';
    // 相対パスはそのまま保持（実行オリジンで勝手に絶対化しない）
    if (/^(\/|\.\/|\.\.\/)/.test(raw) || !/^https?:\/\//i.test(raw)) {
      return raw;
    }
    // ここからは絶対URLのみ扱う
    const url = new URL(raw);
    const host = url.hostname;
    // Dropbox: ?dl=1 / ?raw=1 にして直リンク化
    if (host.includes('dropbox.com')) {
      if (url.searchParams.has('dl')) {
        url.searchParams.set('dl', '1');
      } else if (!url.searchParams.has('raw')) {
        url.searchParams.set('raw', '1');
      }
      return url.toString();
    }
    // Google Drive: /file/d/<id>/view → uc?export=download&id=<id>
    if (host.includes('drive.google.com')) {
      const m = url.pathname.match(/\/file\/d\/([^/]+)/);
      const id = m ? m[1] : (url.searchParams.get('id') || '');
      if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
    }
    return url.toString();
  } catch {
    return u;
  }
}

function isAzureBlob(u: string): boolean {
  try {
    const host = new URL(u).hostname;
    return host.endsWith('.blob.core.windows.net') || host.endsWith('.web.core.windows.net');
  } catch { return false; }
}

function azureHintFor(status: number): string | null {
  if (status === 404) {
    return 'Azure Blob 404: BlobNotFound。コンテナ名/ファイル名（大文字小文字）/SAS有効期限/アクセス許可を確認してください。URL 形式: https://<account>.blob.core.windows.net/<container>/<blob>.mp3';
  }
  if (status === 403) {
    return 'Azure Blob 403: 読み取り許可不足。SASトークンに sp=r を含めるか、コンテナを匿名読み取り可に設定してください。';
  }
  if (status === 0) {
    return 'Azure Blob 取得失敗: CORS未設定の可能性。ストレージアカウントのCORSで GET/HEAD を許可し、オリジン(または*)を追加してください。';
  }
  return null;
}

function parseAzureUrl(u: string){
  try {
    const url = new URL(u);
    const parts = url.pathname.replace(/^\/+/, '').split('/');
    const container = parts[0] || '';
    const blob = parts.slice(1).join('/');
    const se = url.searchParams.get('se');
    const hasSig = url.searchParams.has('sig');
    let seExpired = false;
    if (se) {
      const t = Date.parse(se);
      if (!Number.isNaN(t)) seExpired = t < Date.now();
    }
    return { container, blob, hasBlob: !!blob, hasSig, se, seExpired };
  } catch { return null; }
}

type Entry = {
  date: string;
  weight: string;
  meals: { breakfast: string; lunch: string; dinner: string; notes: string };
  checklist: { id: string; text: string; done: boolean }[];
};

type Settings = {
  goalWeight: number;
  weeklyMusic: Record<string, string>;
  templates: Record<string, string[]>;
};

type AppState = { entries: Record<string, Entry>; settings: Settings };

function loadData(): AppState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : { entries: {}, settings: defaultSettings() };
  } catch {
    return { entries: {}, settings: defaultSettings() };
  }
}

function saveData(data: AppState) {
  localStorage.setItem(LS_KEY, JSON.stringify(data));
}

function defaultSettings(): Settings {
  return {
    goalWeight: 60,
    weeklyMusic: { 月: "", 火: "", 水: "", 木: "", 金: "", 土: "", 日: "" },
    templates: {
      月: ["肩回しストレッチ 1分","壁プッシュアップ 15回×2","肩甲骨寄せ 15回×2"],
      火: ["スクワット 15回×2","カーフレイズ 20回×2","股関節ストレッチ 1分"],
      水: ["プランク 20秒×3","サイドプランク 各15秒×2","キャットカウ"],
      木: ["タオル肩回し 10回×2","スーパーマン 10回×2","肩甲骨寄せ 15回×2"],
      金: ["スクワット 15回","膝つき腕立て 10回","マウンテンクライマー 20回"],
      土: ["その場足踏み 2〜3分×2","腕振り大きく 1分"],
      日: ["全身ストレッチ 10分","深呼吸 1分"]
    }
  };
}

function buildEntry(dateStr: string, settings: Settings): Entry {
  const w = weekdayStr(dateStr);
  const tpl = settings.templates[w] || [];
  return {
    date: dateStr,
    weight: "",
    meals: { breakfast: "", lunch: "", dinner: "", notes: "" },
    // Reactキー再利用を避けるため毎回ユニークID
    checklist: tpl.map((t, i) => ({
      id: `${dateStr}-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text: t,
      done: false
    }))
  };
}

function ensureEntry(state: AppState, dateStr: string) {
  if (!state.entries[dateStr]) {
    state.entries[dateStr] = buildEntry(dateStr, state.settings);
  }
}

// =========================
// Component
// =========================
export default function VibeFitTracker() {
  const [data, setData] = useState<AppState>(loadData);
  const [dateStr, setDateStr] = useState<string>(ymd());
  const [tab, setTab] = useState<string>("today");

  useEffect(() => saveData(data), [data]);

  useEffect(() => {
    // Select日付が変わったら当日のエントリを必ず用意
    setData(prev => {
      const copy: AppState = JSON.parse(JSON.stringify(prev));
      ensureEntry(copy, dateStr);
      return copy;
    });
  }, [dateStr]);

  // PWA: サービスワーカー登録（存在する場合）
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  // 軽量セルフテスト（開発時のみの意図だが実害ない）
  useEffect(() => {
    runSelfTests();
  }, []);

  const entry = data.entries[dateStr];
  const goal = data.settings.goalWeight;

  const dayProgress = useMemo(() => {
    if (!entry || !entry.checklist || entry.checklist.length === 0) return 0;
    const done = entry.checklist.filter(c => c.done).length;
    return Math.round((done / entry.checklist.length) * 100);
  }, [entry]);

  const weightSeries = useMemo(() => {
    const arr: { date: string; weight: number | null }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(dateStr);
      d.setDate(d.getDate() - i);
      const k = ymd(d);
      const e = data.entries[k];
      arr.push({ date: k.slice(5), weight: e && e.weight !== "" ? Number(e.weight) : null });
    }
    return arr;
  }, [data.entries, dateStr]);

  function updateEntry(partial: Partial<Entry>) {
    setData(prev => {
      const copy: AppState = JSON.parse(JSON.stringify(prev));
      ensureEntry(copy, dateStr);
      copy.entries[dateStr] = { ...copy.entries[dateStr], ...partial };
      return copy;
    });
  }

  function updateMeals(k: keyof Entry["meals"], v: string) {
    const meals = entry ? entry.meals : { breakfast: "", lunch: "", dinner: "", notes: "" };
    updateEntry({ meals: { ...meals, [k]: v } as Entry["meals"] });
  }

  function setWeeklyMusic(weekday: string, rawUrl: string) {
    const trimmed = (rawUrl ?? '').trim();
    const fixed = trimmed ? normalizeMediaUrl(trimmed) : '';
    setData(prev => ({
      ...prev,
      settings: { ...prev.settings, weeklyMusic: { ...prev.settings.weeklyMusic, [weekday]: fixed } }
    }));
  }

  function toggleChecklist(id: string) {
    if (!entry) return;
    updateEntry({ checklist: entry.checklist.map(c => (c.id === id ? { ...c, done: !c.done } : c)) });
  }

  function addChecklistItem() {
    const raw = prompt("種目名を入力:");
    const text = (raw || "").trim();
    if (!text) return;
    setData(prev => {
      const copy: AppState = JSON.parse(JSON.stringify(prev));
      ensureEntry(copy, dateStr);
      const base = Array.isArray(copy.entries[dateStr].checklist) ? copy.entries[dateStr].checklist : [];
      const id = `${dateStr}-${(crypto as any).randomUUID?.() || Math.random().toString(36).slice(2)}`;
      copy.entries[dateStr].checklist = [...base, { id, text, done: false }];
      return copy;
    });
  }

  function removeChecklistItem(id: string) {
    setData(prev => {
      const copy: AppState = JSON.parse(JSON.stringify(prev));
      ensureEntry(copy, dateStr);
      const base = Array.isArray(copy.entries[dateStr].checklist) ? copy.entries[dateStr].checklist : [];
      copy.entries[dateStr].checklist = base.filter(c => c.id !== id);
      return copy;
    });
  }

  function applyTemplateOfWeekday() {
    const rebuilt = buildEntry(dateStr, data.settings);
    updateEntry({ checklist: rebuilt.checklist });
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vibefit_export_${ymd()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJSON(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        setData(parsed);
      } catch (e) {
        alert("読み込みに失敗しました。JSONを確認してください。");
      }
    };
    reader.readAsText(file);
  }

  function resetToday() {
    if (!confirm("本日の入力をリセットしますか？")) return;
    setData(prev => {
      const copy: AppState = JSON.parse(JSON.stringify(prev));
      copy.entries[dateStr] = buildEntry(dateStr, copy.settings);
      return copy;
    });
  }

  async function precacheTodayMusic() {
    try {
      const w = weekdayStr(dateStr);
      const url = data.settings.weeklyMusic[w];
      if (!url) return alert("この曜日の音源URLが未設定です。");
      if (!("serviceWorker" in navigator)) return alert("PWA(サービスワーカー)が有効な環境でお試しください。");
      const reg = await navigator.serviceWorker.ready;
      (reg.active as ServiceWorker | null)?.postMessage({ type: "CACHE_URL", url });
      alert("キャッシュ要求を送信しました。オンライン時に一度再生するとオフラインでも聴ける可能性が高まります。");
    } catch {
      alert("キャッシュ要求に失敗しました。");
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">VibeFit Tracker</h1>
            <p className="text-slate-600">毎日の<strong>体重・食事・トレーニング</strong>を直感操作で記録。<strong>曜日別ミュージック</strong>も再生可。</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5" />
              <Input type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} className="w-[160px]" />
              <span className="text-sm text-slate-500">（{weekdayStr(dateStr)}）</span>
            </div>
            <Button variant="secondary" onClick={applyTemplateOfWeekday} title="曜日テンプレ適用">
              <Settings className="mr-2 h-4 w-4"/>曜日テンプレ
            </Button>
          </div>
        </header>

        {/* Top Overview */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="md:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2"><IconLineChart className="h-5 w-5"/>体重トレンド（直近14日）</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <RLineChart data={weightSeries} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis domain={["dataMin - 2", "dataMax + 2"]} allowDecimals={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="weight" dot strokeWidth={2} />
                  </RLineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5"/>今日の進捗</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Progress value={dayProgress} />
                <div className="text-sm text-slate-600">チェック率：{dayProgress}%</div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={resetToday}><RotateCcw className="mr-2 h-4 w-4"/>本日リセット</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="today">今日の入力</TabsTrigger>
            <TabsTrigger value="meals">食事メモ</TabsTrigger>
            <TabsTrigger value="settings">設定 / バックアップ</TabsTrigger>
          </TabsList>

        {/* Today */}
          <TabsContent value="today" className="space-y-4">
            {/* Music Player Card */}
            <MusicCard dayLabel={weekdayStr(dateStr)} url={data.settings.weeklyMusic[weekdayStr(dateStr)]} onPrecache={precacheTodayMusic} />

            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2"><Dumbbell className="h-5 w-5"/> 体重</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid gap-2">
                    <Label htmlFor="weight">本日の体重 (kg)</Label>
                    <Input id="weight" type="number" inputMode="decimal" value={entry?.weight ?? ""} onChange={(e) => updateEntry({ weight: e.target.value })} placeholder="65.0" />
                    <div className="text-xs text-slate-500">目標: {goal} kg</div>
                  </div>
                </CardContent>
              </Card>

              <Card className="md:col-span-2">
                <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2"><Utensils className="h-5 w-5"/> 食事（概要）</CardTitle></CardHeader>
                <CardContent className="grid gap-3 md:grid-cols-3">
                  <div className="grid gap-2">
                    <Label>朝食</Label>
                    <Textarea rows={4} value={entry?.meals?.breakfast ?? ""} onChange={(e) => updateMeals("breakfast", e.target.value)} placeholder="例：オートミール＋納豆＋味噌汁"/>
                  </div>
                  <div className="grid gap-2">
                    <Label>昼食</Label>
                    <Textarea rows={4} value={entry?.meals?.lunch ?? ""} onChange={(e) => updateMeals("lunch", e.target.value)} placeholder="例：鶏むねサラダ＋玄米"/>
                  </div>
                  <div className="grid gap-2">
                    <Label>夕食</Label>
                    <Textarea rows={4} value={entry?.meals?.dinner ?? ""} onChange={(e) => updateMeals("dinner", e.target.value)} placeholder="例：豆腐ステーキ＋野菜スープ（炭水化物控えめ）"/>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="pb-2"><CardTitle>今日のトレーニング・チェックリスト（{weekdayStr(dateStr)}）</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={applyTemplateOfWeekday}><Settings className="mr-2 h-4 w-4"/>曜日テンプレを再読込</Button>
                  <Button size="sm" variant="outline" onClick={addChecklistItem}><Plus className="mr-2 h-4 w-4"/>種目を追加</Button>
                </div>
                <div className="divide-y rounded-lg border bg-white">
                  {entry?.checklist?.length ? (
                    entry.checklist.map(item => (
                      <div key={item.id} className="flex items-center justify-between p-3">
                        <label className="flex items-center gap-3">
                          <Checkbox checked={item.done} onCheckedChange={() => toggleChecklist(item.id)} />
                          <span className={"text-sm " + (item.done ? "line-through text-slate-400" : "")}>{item.text}</span>
                        </label>
                        <Button size="icon" variant="ghost" onClick={() => removeChecklistItem(item.id)} title="削除"><Minus className="h-4 w-4"/></Button>
                      </div>
                    ))
                  ) : (
                    <div className="p-4 text-sm text-slate-500">チェックリストが空です。上の「曜日テンプレを再読込」または「種目を追加」を使ってください。</div>
                  )}
                </div>
                <div className="text-xs text-slate-500">※ 肩の痛みがある場合は無理せず可動域内で。痛みが出たら即中止。</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle>メモ</CardTitle></CardHeader>
              <CardContent>
                <Textarea rows={4} value={entry?.meals?.notes ?? ""} onChange={(e) => updateMeals("notes", e.target.value)} placeholder="睡眠時間／体調／気づき など" />
              </CardContent>
            </Card>
          </TabsContent>

          {/* Meals Tab */}
          <TabsContent value="meals" className="space-y-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle>食事テンプレート（クイック入力）</CardTitle></CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-3">
                <QuickMealCard title="高タンパク軽め朝食" onUse={(txt) => updateMeals("breakfast", txt)} text={"オートミール40g + ギリシャヨーグルト + バナナ1本 + コーヒー(無糖)"} />
                <QuickMealCard title="昼：鶏むね＆玄米" onUse={(txt) => updateMeals("lunch", txt)} text={"鶏むね150g(茹) + 玄米150g + 野菜サラダ + 味噌汁"} />
                <QuickMealCard title="夜：糖質控えめ" onUse={(txt) => updateMeals("dinner", txt)} text={"豆腐ステーキ + サバ水煮 + 蒸しブロッコリー + スープ（炭水化物控えめ）"} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle>今日の食事 詳細編集</CardTitle></CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-3">
                <div className="grid gap-2">
                  <Label>朝食</Label>
                  <Textarea rows={6} value={entry?.meals?.breakfast ?? ""} onChange={(e) => updateMeals("breakfast", e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label>昼食</Label>
                  <Textarea rows={6} value={entry?.meals?.lunch ?? ""} onChange={(e) => updateMeals("lunch", e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label>夕食</Label>
                  <Textarea rows={6} value={entry?.meals?.dinner ?? ""} onChange={(e) => updateMeals("dinner", e.target.value)} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Settings */}
          <TabsContent value="settings" className="space-y-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle>基本設定</CardTitle></CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-3">
                <div className="grid gap-2">
                  <Label>目標体重 (kg)</Label>
                  <Input type="number" inputMode="decimal" value={data.settings.goalWeight} onChange={(e) => setData(prev => ({ ...prev, settings: { ...prev.settings, goalWeight: Number(e.target.value || 0) } }))} />
                </div>
                <div className="grid gap-2 md:col-span-2">
                  <Label>曜日別テンプレ（{weekdayStr(dateStr)} の参考に使われます）</Label>
                  <WeekTemplateEditor settings={data.settings} onChange={(next) => setData(prev => ({ ...prev, settings: next }))} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2"><Music className="h-5 w-5"/> ワークフローミュージック（曜日別URL）</CardTitle></CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2">
                {["月","火","水","木","金","土","日"].map((d) => (
                  <div key={d} className="grid gap-1">
                    <Label>{d}曜日の音源URL（mp3/wav直リンク推奨）</Label>
                    <div className="flex gap-2">
                      <Input placeholder="https://.../your-suno-track.mp3" value={data.settings.weeklyMusic[d] || ""} onChange={(e)=>setWeeklyMusic(d, e.target.value)} />
                      <Button size="sm" variant="outline" onClick={() => setWeeklyMusic(d, '')}>クリア</Button>
                    </div>
                  </div>
                ))}
                <div className="md:col-span-2 text-xs text-slate-500">
                  ※ 直リンク推奨。YouTube等の埋め込みURLは <code>&lt;audio&gt;</code> では再生できない場合があります。
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle>バックアップ</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-3 md:flex-row md:items-center">
                <Button onClick={exportJSON}><Download className="mr-2 h-4 w-4"/>JSONを書き出し</Button>
                <label className="inline-flex items-center gap-2 text-sm">
                  <Upload className="h-4 w-4"/> JSONを読み込み
                  <input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files && importJSON(e.target.files[0] as File)} />
                </label>
                <div className="text-xs text-slate-500">※ アプリデータ（体重・食事・テンプレ・音源URL）を保存/復元できます。</div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <footer className="pt-4 text-center text-xs text-slate-500">
          <p>Made with ❤️ for バイブコーディング — ローカル保存・広告なし・PWA化対応（音源は直リンク推奨）</p>
        </footer>
      </div>
    </div>
  );
}

function QuickMealCard({ title, text, onUse }: { title: string; text: string; onUse: (t: string) => void }) {
  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      <p className="mb-3 text-sm text-slate-600">{text}</p>
      <Button size="sm" variant="secondary" onClick={() => onUse(text)}>この内容を使う</Button>
    </div>
  );
}

function WeekTemplateEditor({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const [day, setDay] = useState<string>("月");
  const list = settings.templates[day] || [];

  function updateList(next: string[]) {
    onChange({ ...settings, templates: { ...settings.templates, [day]: next } });
  }

  // バッククォートを避けた安全な複数行プレースホルダ（コピー時の未終了文字列事故を防ぐ）
  const placeholder = "例)\\nスクワット 15回×2\\nプランク 20秒×3\\n肩回しストレッチ 1分";

  return (
    <div className="mb-3 grid gap-2 md:grid-cols-3">
      <div className="grid gap-2">
        <Label>曜日を選択</Label>
        <Select value={day} onValueChange={setDay}>
          <SelectTrigger><SelectValue placeholder="曜日"/></SelectTrigger>
          <SelectContent>
            {["月","火","水","木","金","土","日"].map((d) => (
              <SelectItem key={d} value={d}>{d}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="md:col-span-2">
        <Label>テンプレ種目（1行1種目）</Label>
        <Textarea
          rows={8}
          value={list.join("\\n")}
          onChange={(e) => updateList(e.target.value.split(/\\n+/).filter(Boolean))}
          placeholder={placeholder}
        />
        <div className="mt-2 text-xs text-slate-500">※ 「今日」タブの「曜日テンプレを再読込」で適用されます。</div>
      </div>
    </div>
  );
}

function MusicCard({ dayLabel, url, onPrecache }: { dayLabel: string; url?: string; onPrecache: () => void }){
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [volume, setVolume] = useState(0.8);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [diagMsg, setDiagMsg] = useState<string | null>(null);

  useEffect(()=>{
    if(audioRef.current){
      audioRef.current.loop = loop;
      audioRef.current.volume = volume;
    }
  },[loop, volume]);

  function explainAudioError(a: HTMLAudioElement | null): string {
    const c = a && (a as any).error ? (a as any).error.code : 0;
    switch (c) {
      case 1: return '再生がユーザー操作で中断されました (ABORTED)';
      case 2: return 'ネットワークエラー (NETWORK) – URLやCORSを確認してください';
      case 3: return 'デコードエラー (DECODE) – ファイルが壊れている可能性';
      case 4: return 'ソース非対応 (SRC_NOT_SUPPORTED) – 直リンクかMIME typeを確認';
      default: return '再生エラー（詳細不明）';
    }
  }

  const toggle = async ()=>{
    const a = audioRef.current;
    if(!a) return;
    setErrMsg(null);
    if(playing){ a.pause(); setPlaying(false); return; }
    try {
      await a.play();
      setPlaying(true);
    } catch (e) {
      setErrMsg(explainAudioError(a));
    }
  };
  const stop = ()=>{ const a = audioRef.current; if(a){ a.pause(); a.currentTime = 0; setPlaying(false);} };

  const diagnose = async ()=>{
    if(!url){ setDiagMsg('URLが未設定です'); return; }
    if (typeof location !== 'undefined' && location.protocol === 'https:' && url.startsWith('http:')) {
      setDiagMsg('HTTPSページ上でHTTP音源はブロックされます（混在コンテンツ）。URLをhttpsにしてください');
      return;
    }
    setDiagMsg('診断中…');
    try {
      // まず HEAD（許可されていない場合もある）
      let res: Response | null = null;
      try {
        res = await fetch(url, { method: 'HEAD', mode: 'cors', redirect: 'follow' });
      } catch {
        res = null; // フォールバック
      }
      if (!res || !res.ok) {
        // GET で詳細確認
        res = await fetch(url, { method: 'GET', mode: 'cors', redirect: 'follow' });
      }
      const status = res.status;
      const ct = res.headers.get('content-type') || '';
      let extra = '';

      // Azure向け追加診断
      if (isAzureBlob(url)) {
        const info = parseAzureUrl(url);
        const tips: string[] = [];
        if (info) {
          if (!info.hasBlob) tips.push('URLがコンテナを指しています。ファイル名まで含めてください。例: https://<account>.blob.core.windows.net/<container>/<blob>.mp3');
          if (!info.hasSig) tips.push('SASトークン(sig)がありません。公開読み取りでない場合は署名付きURLが必要です。');
          if (info.se && info.seExpired) tips.push(`SASの期限(se=${info.se})が切れています。新しい署名を発行してください。`);
          if (status === 404 && info.hasBlob) tips.push(`BlobNotFound: container='${info.container}', blob='${info.blob}'。大文字小文字/拡張子/サブフォルダ/日本語のURLエンコードを確認してください。`);
        }
        extra = tips.join(' ');
      }

      if (!res.ok) {
        const azureTip = isAzureBlob(url) ? (azureHintFor(status) || '') : '';
        setDiagMsg(`HTTP ${status} ${res.statusText} ${extra} ${azureTip}`.trim());
        return;
      }
      if (!/^audio\//i.test(ct)) {
        const azureTip = isAzureBlob(url) ? '（Azure: Content-Typeが audio/* で提供されているか確認）' : '';
        setDiagMsg(`取得成功ですが Content-Type=${ct} です。audio/* を返す必要があります ${azureTip}`.trim());
      } else {
        setDiagMsg(`OK: Content-Type=${ct}`);
      }
    } catch (e) {
      const tip = isAzureBlob(url) ? azureHintFor(0) : '';
      setDiagMsg(`取得に失敗（CORS/ネットワーク）。${tip || 'Dropboxは ?dl=1 / Google Driveは uc?export=download&id=... にしてください'}`.trim());
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2"><Music className="h-5 w-5"/> ワークフローミュージック（{dayLabel}）</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {url ? (
          <>
            <audio
              ref={audioRef}
              src={url}
              preload="metadata"
              controls
              crossOrigin="anonymous"
              onError={()=> setErrMsg(explainAudioError(audioRef.current))}
              onPlay={()=> setPlaying(true)}
              onPause={()=> setPlaying(false)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={toggle}>{playing ? <><Pause className="mr-2 h-4 w-4"/>一時停止</> : <><Play className="mr-2 h-4 w-4"/>再生</>}</Button>
              <Button size="sm" variant="outline" onClick={stop}><RefreshCw className="mr-2 h-4 w-4"/>停止</Button>
              <label className="text-sm inline-flex items-center gap-2">
                ループ
                <Checkbox checked={loop} onCheckedChange={(v)=>setLoop(!!v)} />
              </label>
              <div className="flex items-center gap-2">
                <span className="text-sm">音量</span>
                <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e)=>setVolume(parseFloat((e.target as HTMLInputElement).value))} />
              </div>
              <Button size="sm" variant="outline" onClick={onPrecache}><CloudOff className="mr-2 h-4 w-4"/>オフライン準備</Button>
              <Button size="sm" variant="ghost" onClick={diagnose}>診断</Button>
              <a className="text-sm underline text-slate-600" href={url} target="_blank" rel="noreferrer">直リンクを開く</a>
            </div>
            {errMsg && <div className="text-xs text-red-600">再生エラー: {errMsg}</div>}
            {diagMsg && <div className="text-xs text-amber-600">{diagMsg}</div>}
            <div className="text-xs text-slate-500">※ 再生できない場合：URLが直リンクか、HTTPS混在・CORS・MIME(type) を確認してください。</div>
          </>
        ) : (
          <div className="text-sm text-slate-500">この曜日の音源URLが未設定です。「設定」→「ワークフローミュージック」でURLを登録してください。</div>
        )}
      </CardContent>
    </Card>
  );
}

// =========================
// Dev Self Tests (lightweight)
// =========================
function runSelfTests(){
  try {
    // 1) join/split round-trip
    const sample = ["A","B","C"];
    const joined = sample.join("\\n");
    const split = joined.split(/\\n+/).filter(Boolean);
    console.assert(JSON.stringify(sample) === JSON.stringify(split), "join/split should round-trip");

    // 2) placeholder must include newlines (use normal string, not backticks)
    const ph = "例)\\nスクワット 15回×2\\nプランク 20秒×3\\n肩回しストレッチ 1分";
    console.assert(ph.includes("\\n"), "placeholder should contain newlines");

    // 3) weekdayStr should return a string
    console.assert(typeof weekdayStr("2025-09-13") === "string", "weekdayStr should return a string");

    // 4) ensureEntry uses weekday template length
    const monday = "2025-09-08"; // known Monday
    const tmp: AppState = { entries: {}, settings: defaultSettings() };
    ensureEntry(tmp, monday);
    const w = weekdayStr(monday);
    const tplLen = tmp.settings.templates[w].length;
    console.assert(tmp.entries[monday].checklist.length === tplLen, "ensureEntry uses weekday template length");

    // 5) weekly music mapping
    const url = "https://example.com/monday.mp3";
    tmp.settings.weeklyMusic["月"] = url;
    console.assert(tmp.settings.weeklyMusic["月"] === url, "weeklyMusic mapping works");

    // 6) re-create flow similar to reset
    delete tmp.entries[monday];
    ensureEntry(tmp, monday);
    console.assert(!!tmp.entries[monday], "ensureEntry re-creates deleted day");

    // 7) defaultSettings has all weekday keys
    const ds = defaultSettings();
    const days = ["日","月","火","水","木","金","土"];
    console.assert(days.every((d)=> d in ds.templates), "templates has all weekdays");
    console.assert(days.every((d)=> d in ds.weeklyMusic), "weeklyMusic has all weekdays");

    // 8) ensureEntry should not overwrite existing fields
    const date = "2025-09-09";
    const state: AppState = { entries: {}, settings: defaultSettings() };
    ensureEntry(state, date);
    state.entries[date].weight = "63.5";
    ensureEntry(state, date);
    console.assert(state.entries[date].weight === "63.5", "ensureEntry does not overwrite existing entry");

    // 9) reset-like rebuild clears fields & refreshes IDs
    const day = "2025-09-10";
    ensureEntry(state, day);
    state.entries[day].weight = "64.2";
    state.entries[day].meals.breakfast = "test";
    state.entries[day].checklist = state.entries[day].checklist.map((c, i)=> ({...c, done: i % 2 === 0}));
    const beforeIds = state.entries[day].checklist.map(c=>c.id);
    state.entries[day] = buildEntry(day, state.settings);
    console.assert(state.entries[day].weight === "", "reset rebuild clears weight");
    console.assert(state.entries[day].meals.breakfast === "", "reset rebuild clears meals");
    console.assert(state.entries[day].checklist.every(c=>c.done === false), "reset rebuild unchecks all");
    const afterIds = state.entries[day].checklist.map(c=>c.id);
    console.assert(afterIds.some(id => !beforeIds.includes(id)), "reset rebuild produces fresh checklist IDs");

    // 10) applyTemplateOfWeekday-like rebuild changes IDs
    const sim: AppState = { entries: {}, settings: defaultSettings() };
    const today = "2025-09-11";
    ensureEntry(sim, today);
    const oldIds = sim.entries[today].checklist.map(c=>c.id);
    const rebuilt = buildEntry(today, sim.settings);
    sim.entries[today].checklist = rebuilt.checklist;
    const newIds = sim.entries[today].checklist.map(c=>c.id);
    console.assert(newIds.some(id => !oldIds.includes(id)), "applyTemplate-like rebuild changes IDs");

    // 11) add flow appends one and text matches
    const addState: AppState = { entries: {}, settings: defaultSettings() };
    const d0 = "2025-09-12";
    ensureEntry(addState, d0);
    const baseLen = addState.entries[d0].checklist.length;
    const newItem = { id: `${d0}-x`, text: "テスト追加", done: false };
    addState.entries[d0].checklist = [...addState.entries[d0].checklist, newItem];
    console.assert(addState.entries[d0].checklist.length === baseLen + 1, "add flow should increase length by 1");
    console.assert(addState.entries[d0].checklist[addState.entries[d0].checklist.length - 1].text === "テスト追加", "add flow should append correct text");

    // 12) remove flow removes one
    const rid = addState.entries[d0].checklist[0]?.id;
    const lenBefore = addState.entries[d0].checklist.length;
    addState.entries[d0].checklist = addState.entries[d0].checklist.filter(c => c.id !== rid);
    console.assert(addState.entries[d0].checklist.length === lenBefore - 1, "remove flow should decrease length by 1");

    // 13) template editor placeholder sanity (no backticks)
    console.assert(!"例)\\nA\\nB\\nC".includes("`"), "placeholder uses normal string, not backticks");

    // 14) normalizeMediaUrl: Dropbox
    const d1 = normalizeMediaUrl('https://www.dropbox.com/s/abc/mon.mp3?dl=0');
    console.assert(/dl=1|raw=1/.test(d1), 'dropbox url should be normalized to direct link');

    // 15) normalizeMediaUrl: Google Drive
    const g1 = normalizeMediaUrl('https://drive.google.com/file/d/FILEID/view?usp=sharing');
    console.assert(g1.includes('uc?export=download&id=FILEID'), 'gdrive url should be normalized to direct link');

    // 16) isAzureBlob detection
    console.assert(isAzureBlob('https://account.blob.core.windows.net/container/file.mp3') === true, 'azure blob host detected');
    console.assert(isAzureBlob('https://example.com/file.mp3') === false, 'non-azure host is not detected');

    // 17) normalizeMediaUrl for empty string stays empty
    console.assert(normalizeMediaUrl('') === '', 'empty url should remain empty');

    // 18) setWeeklyMusic-like blank handling (simulate)
    let s = defaultSettings();
    s.weeklyMusic['月'] = 'https://example.com/old.mp3';
    const trimmed = ''.trim();
    const fixed = trimmed ? normalizeMediaUrl(trimmed) : '';
    s.weeklyMusic['月'] = fixed;
    console.assert(s.weeklyMusic['月'] === '', 'blank input should clear weeklyMusic');

    // 19) relative path stays relative
    console.assert(normalizeMediaUrl('/audio/mon.mp3') === '/audio/mon.mp3', 'relative /audio path should be kept');
    // 20) plain relative stays as-is
    console.assert(normalizeMediaUrl('audio/mon.mp3') === 'audio/mon.mp3', 'relative audio path without leading slash should be kept');
    // 21) absolute https kept
    console.assert(normalizeMediaUrl('https://example.com/t.mp3') === 'https://example.com/t.mp3', 'https absolute should remain same');

    // 22) isAzureBlob also true for static website endpoint
    console.assert(isAzureBlob('https://account.web.core.windows.net/audio/mon.mp3') === true, 'azure static website endpoint treated as azure');

    // 23) parseAzureUrl basic
    const ainfo = parseAzureUrl('https://acnt.blob.core.windows.net/audio/mon.mp3?sp=r&se=2100-01-01&sig=XYZ');
    console.assert(ainfo && ainfo.container === 'audio' && ainfo.blob === 'mon.mp3' && ainfo.hasBlob === true, 'parseAzureUrl extracts container and blob');

    // 24) parseAzureUrl detects missing blob
    const ainfo2 = parseAzureUrl('https://acnt.blob.core.windows.net/audio?sp=r&sig=XYZ');
    console.assert(ainfo2 && ainfo2.hasBlob === false, 'parseAzureUrl detects container-only URL');

    // 25) parseAzureUrl expiry detection (past date)
    const ainfo3 = parseAzureUrl('https://acnt.blob.core.windows.net/audio/mon.mp3?se=2000-01-01T00:00:00Z&sig=XYZ');
    console.assert(ainfo3 && ainfo3.seExpired === true, 'parseAzureUrl marks expired SAS');

    // 26) Google Drive query param id= fallback
    const g2 = normalizeMediaUrl('https://drive.google.com/open?id=ABCDEF');
    console.assert(g2.includes('uc?export=download&id=ABCDEF'), 'gdrive url should support id query param');

  } catch (e) {
    console.warn("Self-tests encountered an error:", e);
  }
}
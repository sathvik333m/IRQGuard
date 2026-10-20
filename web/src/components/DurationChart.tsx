import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip,
  XAxis, YAxis,
} from 'recharts'

export default function DurationChart({ data }: { data: Array<{ name: string; duration: number | null | undefined }> }) {
  return <ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 6, right: 8, left: -20, bottom: 0 }}>
    <CartesianGrid vertical={false} stroke="var(--line-soft)" strokeDasharray="3 5" />
    <XAxis dataKey="name" tick={{ fill: 'var(--text-dim)', fontSize: 12 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
    <YAxis tick={{ fill: 'var(--text-dim)', fontSize: 12 }} axisLine={false} tickLine={false} unit="ms" />
    <Tooltip contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--line)', borderRadius: 7, color: 'var(--text)' }} formatter={(value) => [`${value} ms`, 'Duration']} />
    <Bar dataKey="duration" fill="var(--accent)" radius={[3, 3, 0, 0]} maxBarSize={22} />
  </BarChart></ResponsiveContainer>
}

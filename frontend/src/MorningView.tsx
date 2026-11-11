import type { KeyboardEvent } from 'react'
import {
  Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Coffee, Droplet, Droplets, Gift, House, Leaf,
  ShieldCheck, Shirt, Snowflake, Sprout, Sun, SunMedium, Sunrise, Sunset, ThermometerSnowflake, ThermometerSun, TrendingDown, TrendingUp, Umbrella, Wind,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { CATEGORY_ICON, CATEGORY_LABEL } from './houseWatchLabels'
import { LeftOnAction } from './LeftOnAction'
import { ReplaceNow } from './ReplaceNow'
import type { ReactNode } from 'react'
import { formatOnDuration } from './longRunningLights'
import { christmasCountdown } from './seasons'
import type { Advice, JournalEntry, MorningBrief } from './useMorningBrief'
import { PageFrame } from './ui/PageFrame'
import { InlineError, LoadingState } from './ui/StateMessages'
import './MorningView.css'

export const MORNING_SLIDES = ['Today', 'Around the house', 'Ahead', 'Week'] as const

const ADVICE_ICON: Record<string, LucideIcon> = {
  snow: Snowflake, ice: ThermometerSnowflake, freeze: ThermometerSnowflake, frost: ThermometerSnowflake, cold: ThermometerSnowflake,
  wind: Wind, leaves: Leaf, storm: CloudLightning, rain: Umbrella, heat: ThermometerSun, warm: ThermometerSun,
  humid: Droplets, dry: Droplet, uv: SunMedium, fog: CloudFog, evening: Sunset, laundry: Shirt, garden: Sprout,
}

/** WMO weather codes, as Open-Meteo reports them, to a glyph and a word. */
export function skyFor(code: number | null): { Icon: LucideIcon; label: string } {
  if (code === null) return { Icon: CloudSun, label: 'Forecast' }
  if (code <= 1) return { Icon: Sun, label: code === 0 ? 'Clear' : 'Mostly clear' }
  if (code === 2) return { Icon: CloudSun, label: 'Partly cloudy' }
  if (code === 3) return { Icon: Cloud, label: 'Cloudy' }
  if (code === 45 || code === 48) return { Icon: CloudFog, label: 'Fog' }
  if (code >= 51 && code <= 57) return { Icon: CloudDrizzle, label: 'Drizzle' }
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { Icon: CloudRain, label: 'Rain' }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { Icon: CloudSnow, label: 'Snow' }
  if (code >= 95) return { Icon: CloudLightning, label: 'Thunderstorms' }
  return { Icon: CloudSun, label: 'Mixed' }
}

export function greeting(now: Date) {
  const hour = now.getHours()
  return hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
}

/** Last night: from 8 pm yesterday (or tonight, once it is past 8 pm) until now. */
export function overnightEntries(journal: JournalEntry[], now: Date): JournalEntry[] {
  const start = new Date(now)
  if (now.getHours() < 20) start.setDate(start.getDate() - 1)
  start.setHours(20, 0, 0, 0)
  return journal.filter((entry) => {
    const began = new Date(entry.startedAt).getTime()
    const ended = entry.endedAt ? new Date(entry.endedAt).getTime() : now.getTime()
    return began <= now.getTime() && ended >= start.getTime()
  })
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function AdviceList({ items, empty }: { items: Advice[]; empty: string }) {
  if (items.length === 0) return <p className="morning-quiet"><ShieldCheck size={16} aria-hidden="true" />{empty}</p>
  return <ul className="morning-advice">
    {items.map((item) => {
      const Icon = ADVICE_ICON[item.kind] ?? CloudSun
      return <li key={item.id} className={`is-${item.severity}`}>
        <Icon size={20} aria-hidden="true" />
        <div><strong>{item.title}</strong><p>{item.detail}</p></div>
      </li>
    })}
  </ul>
}

interface MorningViewProps {
  brief: MorningBrief | null
  failed: boolean
  now: Date
  slide: number
  onSelectSlide: (index: number) => void
  onRetry: () => void
  /** The live morning-run card, shown at the top of Today while a run is on. */
  run?: ReactNode
}

export function MorningView({ brief, failed, now, slide, onSelectSlide, onRetry, run }: MorningViewProps) {
  const sky = skyFor(brief?.today?.weatherCode ?? null)
  const overnight = brief ? overnightEntries(brief.journal, now) : []
  const nightStart = new Date(now)
  if (now.getHours() < 20) nightStart.setDate(nightStart.getDate() - 1)
  nightStart.setHours(20, 0, 0, 0)
  const actions = (brief?.recentActions ?? []).filter((action) => new Date(action.at).getTime() >= nightStart.getTime())
  const countdown = christmasCountdown(now)
  const todayAdvice = brief?.advice.filter((item) => item.window === 'today' || item.window === 'tonight') ?? []
  const aheadAdvice = brief?.advice.filter((item) => item.window !== 'today' && item.window !== 'tonight') ?? []

  const onTabKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowRight') onSelectSlide((slide + 1) % MORNING_SLIDES.length)
    if (event.key === 'ArrowLeft') onSelectSlide((slide + MORNING_SLIDES.length - 1) % MORNING_SLIDES.length)
  }

  return <section className="morning-view" aria-label="Morning brief">
    <PageFrame
      icon={<Coffee />}
      title={`${greeting(now)}`}
      meta={now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) + (countdown ? ` · ${countdown}` : '')}
    />

    {failed && <InlineError message={brief ? 'Could not refresh the brief; showing the last one.' : 'Morning brief unavailable'} onRetry={onRetry} />}
    {!brief && !failed && <LoadingState label="Putting the morning together" />}

    {brief && <div className="morning-panel" role="tabpanel" id="morning-panel" aria-labelledby={`morning-tab-${slide}`}>
      {slide === 0 && <div className="morning-today">
        {run}
        {brief.today ? <div className="morning-sky glass">
          <sky.Icon size={54} aria-hidden="true" />
          <div className="morning-temps">
            <strong>{brief.today.high ?? '--'}</strong>
            <span>Low {brief.today.low ?? '--'}</span>
            <span>{sky.label}{brief.today.rainChance ? ` · ${brief.today.rainChance}% chance of rain` : ''}</span>
          </div>
          <div className="morning-sun">
            <span><Sunrise size={16} aria-hidden="true" />{brief.today.sunrise ?? '--'}</span>
            <span><Sunset size={16} aria-hidden="true" />{brief.today.sunset ?? '--'}</span>
            {brief.today.daylightChange && <small>{brief.today.daylightChange}</small>}
          </div>
        </div> : <p className="morning-quiet">{brief.forecastError ?? 'No forecast yet.'}</p>}
        <h3>Today and tonight</h3>
        <AdviceList items={todayAdvice} empty="Nothing to prepare for today." />
        {(brief.garden?.length ?? 0) > 0 && <>
          <h3><Sprout size={16} aria-hidden="true" />Garden</h3>
          <AdviceList items={brief.garden ?? []} empty="" />
        </>}
      </div>}

      {slide === 1 && <div className="morning-house">
        <section className="glass morning-card">
          <h3><House size={16} aria-hidden="true" />{now.getHours() < 12 ? 'Overnight' : 'Since last night'}</h3>
          {overnight.length === 0 && actions.length === 0
            ? <p className="morning-quiet"><ShieldCheck size={16} aria-hidden="true" />A quiet night: nothing was left open or on.</p>
            : <ul className="morning-journal">
              {overnight.map((entry) => {
                const Icon = CATEGORY_ICON[entry.category] ?? House
                return <li key={`${entry.rule}-${entry.entityId}-${entry.startedAt}`} className={`is-${entry.severity}`}>
                  <Icon size={16} aria-hidden="true" />
                  <span><strong>{entry.name}</strong> · {CATEGORY_LABEL[entry.category] ?? entry.category}</span>
                  <small>{entry.ongoing
                    ? `since ${clock(entry.startedAt)}, still going`
                    : `${formatOnDuration(entry.seconds * 1000)}, ${clock(entry.startedAt)} – ${clock(entry.endedAt as string)}`}</small>
                </li>
              })}
              {actions.map((action) => <li key={`${action.entityId}-${action.at}`} className="is-info">
                <ShieldCheck size={16} aria-hidden="true" />
                <span>House watch switched off <strong>{action.name ?? action.entityId}</strong></span>
                <small>{clock(action.at)}</small>
              </li>)}
            </ul>}
        </section>
        <section className="glass morning-card">
          <h3><ShieldCheck size={16} aria-hidden="true" />Right now</h3>
          {brief.findings.length === 0
            ? <p className="morning-quiet">Everything is closed, locked and off.</p>
            : <ul className="morning-journal">{brief.findings.map((item) => {
              const Icon = CATEGORY_ICON[item.category] ?? House
              return <li key={`${item.rule}-${item.entityId}`} className={`is-${item.severity}`}>
                <Icon size={16} aria-hidden="true" />
                <span><strong>{item.name}</strong></span>
                <small>{item.detail}</small>
              </li>
            })}</ul>}
          <LeftOnAction count={brief.leftOn.length} onDone={onRetry} />
        </section>
        {(brief.replaceNow?.length ?? 0) > 0 && <ReplaceNow items={brief.replaceNow ?? []} />}
      </div>}

      {slide === 2 && <div className="morning-ahead">
        {brief.days.length > 0 && <div className="morning-days">
          {brief.days.map((day) => {
            const daySky = skyFor(day.weatherCode)
            return <div className="glass morning-day" key={day.date}>
              <span>{day.label}</span>
              <daySky.Icon size={30} aria-label={daySky.label} />
              <strong>{day.high ?? '--'}</strong>
              <small>{day.low ?? '--'}{day.rainChance ? ` · ${day.rainChance}%` : ''}</small>
            </div>
          })}
        </div>}
        <h3>Worth preparing for</h3>
        <AdviceList items={aheadAdvice} empty="Nothing unusual in the next few days." />
        {countdown && <p className="morning-countdown"><Gift size={18} aria-hidden="true" />{countdown}</p>}
      </div>}

      {slide === 3 && <div className="morning-week">
        {brief.weekly ? <>
          <p className="morning-week-headline">{brief.weekly.headline}</p>
          <div className="morning-week-stats">
            {brief.weekly.stats.map((stat) => {
              const change = stat.value - stat.previous
              return <div className="glass morning-week-stat" key={stat.key}>
                <strong>{stat.value}</strong>
                <span>{stat.label}</span>
                <small>
                  {change === 0 ? 'Same as last week' : <>{change < 0 ? <TrendingDown size={13} aria-hidden="true" /> : <TrendingUp size={13} aria-hidden="true" />}{Math.abs(change)} {change < 0 ? 'fewer' : 'more'} than last week</>}
                  {stat.detail ? ` · ${stat.detail}` : ''}
                </small>
              </div>
            })}
          </div>
          {brief.weekly.top.length > 0 && <>
            <h3>Most often</h3>
            <ul className="morning-journal">{brief.weekly.top.map((item) => <li key={item.name} className="is-info">
              <House size={16} aria-hidden="true" /><span><strong>{item.name}</strong></span><small>{item.count} time{item.count === 1 ? '' : 's'} this week</small>
            </li>)}</ul>
          </>}
        </> : <p className="morning-quiet">No weekly report yet.</p>}
      </div>}
    </div>}

    <div className="morning-pager" role="tablist" aria-label="Morning panels" onKeyDown={onTabKey}>
      {MORNING_SLIDES.map((label, index) => <button
        key={label}
        type="button"
        role="tab"
        id={`morning-tab-${index}`}
        aria-selected={slide === index}
        aria-controls="morning-panel"
        tabIndex={slide === index ? 0 : -1}
        className={`glass-pill ${slide === index ? 'is-active' : ''}`}
        onClick={() => onSelectSlide(index)}
      >{label}</button>)}
    </div>
  </section>
}

import { useMemo, type CSSProperties } from 'react'
import { rand } from './seasonalPlay'
import type { SeasonalWeather } from './seasons'
import './WeatherScene.css'

/** Which effects a weather condition calls for. Pure, so it can be tested without rendering. */
export function weatherEffects(weather: SeasonalWeather, month: number) {
  const condition = weather.condition ?? ''
  const rain = ['rainy', 'pouring', 'lightning-rainy', 'snowy-rainy'].includes(condition)
  const snow = condition === 'snowy' || condition === 'snowy-rainy'
  const spring = month >= 2 && month <= 4
  const summer = month >= 5 && month <= 7
  return {
    rain,
    pouring: condition === 'pouring',
    lightning: condition === 'lightning' || condition === 'lightning-rainy',
    fog: condition === 'fog',
    snow,
    hail: condition === 'hail',
    windy: condition === 'windy' || condition === 'windy-variant' || weather.windKmh >= 35,
    sunny: condition === 'sunny',
    hot: condition === 'sunny' && weather.tempC !== null && weather.tempC >= 30,
    stars: condition === 'clear-night',
    fireflies: condition === 'clear-night' && summer && (weather.tempC === null || weather.tempC >= 15),
    clouds: condition === 'cloudy' || condition === 'partlycloudy' || condition === 'windy-variant',
    blossoms: spring && !rain && !snow && condition !== 'hail' && condition !== 'fog',
  }
}

const RAIN_DROPS = 70
const POUR_EXTRA = 70
const STARS = 46
const FIREFLIES = 16
const PETALS = 18
const CLOUDS = 4
const WX_SNOW = 40

function drops(count: number, salt: number) {
  return Array.from({ length: count }, (_, index) => ({
    left: rand(index, salt) * 104 - 2,
    duration: 0.55 + rand(index, salt + 1) * 0.5,
    delay: -rand(index, salt + 2) * 2,
    length: 14 + rand(index, salt + 3) * 22,
    opacity: 0.25 + rand(index, salt + 4) * 0.4,
  }))
}

/**
 * Effects that follow the real weather all year: rain slanted by the wind, lightning, fog, snow,
 * hail, gusts, sunshine, stars and fireflies, drifting clouds, and spring blossom.
 */
export function WeatherScene({ weather, month = new Date().getMonth() }: { weather: SeasonalWeather; month?: number }) {
  const show = weatherEffects(weather, month)
  const rainDrops = useMemo(() => drops(RAIN_DROPS, 40), [])
  const pourDrops = useMemo(() => drops(POUR_EXTRA, 50), [])
  const stars = useMemo(() => Array.from({ length: STARS }, (_, index) => ({
    left: rand(index, 60) * 100, top: rand(index, 61) * 55, size: 1 + rand(index, 62) * 2.2, delay: -rand(index, 63) * 6,
  })), [])
  const fireflies = useMemo(() => Array.from({ length: FIREFLIES }, (_, index) => ({
    left: 5 + rand(index, 70) * 90, top: 45 + rand(index, 71) * 45, duration: 7 + rand(index, 72) * 8, delay: -rand(index, 73) * 10,
    dx: (rand(index, 74) - 0.5) * 140, dy: (rand(index, 75) - 0.5) * 90,
  })), [])
  const petals = useMemo(() => Array.from({ length: PETALS }, (_, index) => ({
    left: rand(index, 80) * 100, duration: 12 + rand(index, 81) * 10, delay: -rand(index, 82) * 22, size: 8 + rand(index, 83) * 7,
    sway: 40 + rand(index, 84) * 70, hue: rand(index, 85) > 0.5 ? '#f7c6d4' : '#fbe1e8',
  })), [])
  const clouds = useMemo(() => Array.from({ length: CLOUDS }, (_, index) => ({
    top: 4 + index * 9 + rand(index, 90) * 6, scale: 0.7 + rand(index, 91) * 0.8, duration: 90 + rand(index, 92) * 60, delay: -rand(index, 93) * 120,
  })), [])
  const flakes = useMemo(() => Array.from({ length: WX_SNOW }, (_, index) => ({
    left: rand(index, 100) * 100, size: 2 + rand(index, 101) * 5, duration: 9 + rand(index, 102) * 10, delay: -rand(index, 103) * 18,
  })), [])

  // Rain leans into the wind: a 40 km/h westerly tilts it about 20 degrees.
  const lean = Math.max(-28, Math.min(28, weather.windX * Math.min(weather.windKmh, 60) * 0.5))
  const conditionClass = weather.condition ? ` wx-${weather.condition}` : ''

  return <div className={`weather-scene${conditionClass}`} style={{ '--rain-lean': `${lean}deg`, '--wind-dir': weather.windX < 0 ? -1 : 1 } as CSSProperties}>
    {show.clouds && <div className="wx-clouds">{clouds.map((cloud, index) => <span key={index} className="wx-cloud" style={{
      top: `${cloud.top}%`, '--cloud-scale': cloud.scale, animationDuration: `${cloud.duration}s`, animationDelay: `${cloud.delay}s`,
    } as CSSProperties} />)}</div>}
    {show.sunny && <div className="wx-sun"><span className="wx-sun-rays" /></div>}
    {show.hot && <div className="wx-heat" />}
    {show.stars && <div className="wx-stars">
      {stars.map((star, index) => <span key={index} style={{ left: `${star.left}%`, top: `${star.top}%`, width: star.size, height: star.size, animationDelay: `${star.delay}s` }} />)}
      <span className="wx-shooting-star" />
    </div>}
    {show.fireflies && <div className="wx-fireflies">{fireflies.map((fly, index) => <span key={index} style={{
      left: `${fly.left}%`, top: `${fly.top}%`, animationDuration: `${fly.duration}s, 2.4s`, animationDelay: `${fly.delay}s, ${fly.delay / 3}s`,
      '--fly-dx': `${fly.dx}px`, '--fly-dy': `${fly.dy}px`,
    } as CSSProperties} />)}</div>}
    {show.fog && <div className="wx-fog"><span /><span /><span /></div>}
    {show.rain && <div className="wx-rain">
      {rainDrops.map((drop, index) => <span key={index} className={index % 2 ? 'is-dense' : undefined} style={{
        left: `${drop.left}%`, height: drop.length, opacity: drop.opacity, animationDuration: `${drop.duration}s`, animationDelay: `${drop.delay}s`,
      }} />)}
      {show.pouring && pourDrops.map((drop, index) => <span key={`pour-${index}`} style={{
        left: `${drop.left}%`, height: drop.length, opacity: drop.opacity, animationDuration: `${drop.duration * 0.8}s`, animationDelay: `${drop.delay}s`,
      }} />)}
    </div>}
    {show.pouring && <div className="wx-splashes">{Array.from({ length: 14 }, (_, index) => <span key={index} style={{ left: `${rand(index, 110) * 100}%`, animationDelay: `${-rand(index, 111) * 1.2}s` }} />)}</div>}
    {show.lightning && <><div className="wx-flash" /><svg className="wx-bolt" viewBox="0 0 60 200" aria-hidden="true"><path d="M34 0 L12 92 L30 92 L18 200 L50 70 L32 70 L46 0 Z" /></svg></>}
    {show.snow && <div className="wx-snow">{flakes.map((flake, index) => <span key={index} style={{
      left: `${flake.left}%`, width: flake.size, height: flake.size, animationDuration: `${flake.duration}s`, animationDelay: `${flake.delay}s`,
    }} />)}</div>}
    {show.hail && <div className="wx-hail">{Array.from({ length: 36 }, (_, index) => <span key={index} style={{
      left: `${rand(index, 120) * 100}%`, animationDuration: `${0.9 + rand(index, 121) * 0.6}s`, animationDelay: `${-rand(index, 122) * 1.5}s`,
    }} />)}</div>}
    {show.windy && <div className="wx-wind">{Array.from({ length: 9 }, (_, index) => <span key={index} style={{
      top: `${8 + rand(index, 130) * 80}%`, width: `${120 + rand(index, 131) * 220}px`, animationDuration: `${2.2 + rand(index, 132) * 2}s`, animationDelay: `${-rand(index, 133) * 4}s`,
    }} />)}</div>}
    {show.blossoms && <div className="wx-blossoms">{petals.map((petal, index) => <span key={index} style={{
      left: `${petal.left}%`, width: petal.size, height: petal.size * 0.7, background: petal.hue,
      animationDuration: `${petal.duration}s, ${3 + (index % 4)}s`, animationDelay: `${petal.delay}s, ${petal.delay}s`, '--petal-sway': `${petal.sway}px`,
    } as CSSProperties} />)}</div>}
  </div>
}

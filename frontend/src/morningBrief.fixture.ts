import type { MorningBrief } from './useMorningBrief'

/** A December morning's brief, shared by the Morning page and app-shell tests. */
export const iso = (day: number, hour: number, minute = 0) => new Date(2026, 11, day, hour, minute).toISOString()

export function morningBrief(overrides: Partial<MorningBrief> = {}): MorningBrief {
  return {
    today: { date: '2026-12-13', high: '41°F', low: '28°F', weatherCode: 3, rainChance: 20, sunrise: '7:12 am', sunset: '4:35 pm', daylightChange: '1 min less daylight than yesterday' },
    advice: [
      { id: 'wind:today', window: 'today', when: 'today', severity: 'warning', kind: 'wind', title: 'Windy today: gusts to 40 mph around 3 pm', detail: 'Secure the patio furniture, cushions, umbrella and trampoline, and bring the bins in.' },
      { id: 'snow:tomorrow', window: 'tomorrow', when: 'tomorrow', severity: 'warning', kind: 'snow', title: 'Heavy snow tomorrow: 4 in', detail: 'Park the car in the garage.' },
    ],
    days: [
      { date: '2026-12-14', label: 'Tomorrow', high: '33°F', low: '25°F', weatherCode: 73, rainChance: 80 },
      { date: '2026-12-15', label: 'Tuesday', high: '30°F', low: '18°F', weatherCode: 1, rainChance: 0 },
    ],
    forecastError: null,
    findings: [],
    journal: [
      { rule: 'garage_open', category: 'garage', severity: 'critical', entityId: 'cover.garage', name: 'Garage door', seconds: 2400, detail: 'Open after dark (40m)', startedAt: iso(12, 22, 10), endedAt: iso(12, 22, 50), ongoing: false },
      { rule: 'light_left_on', category: 'light', severity: 'warning', entityId: 'light.den', name: 'Den lamp', seconds: 9000, detail: '', startedAt: iso(12, 9), endedAt: iso(12, 11, 30), ongoing: false },
    ],
    recentActions: [{ entityId: 'light.porch', name: 'Porch light', service: 'light.turn_off', at: iso(13, 1, 5) }],
    leftOn: [],
    ...overrides,
  }
}

export type AircraftFamily =
  | 'narrowbody'
  | 'widebody'
  | 'quadjet'
  | 'regionaljet'
  | 'turboprop'
  | 'bizjet'
  | 'generic'

/**
 * The upstream feed mixes ICAO type codes ("B738", "A35K", "E75L") with marketing
 * names ("Boeing 777-300ER", "Airbus A350-900"), so we flatten to letters+digits and
 * match on that. Flattening loses word boundaries, which is why every rule below is
 * an explicit token rather than a loose substring: "A340" must not be read as an
 * A320-family "A3.." and "737-700" must not be read as a "707".
 */
const patterns: [RegExp, AircraftFamily][] = [
  // Four-engine types first: B744/A343 would otherwise be swallowed by the B73x/A3xx rules.
  [/A38[0-9X]|A34[0-9X]|747|B74[0-9SRFM]|707|B70[0-9]|DC8|IL(62|76|86)|AN(124|225)|BAE146|B46[1-3]|AVRORJ/, 'quadjet'],
  // A310 sits here and must be matched before the A318/A319 narrowbody rule.
  [/767|B76[0-9]|777|B77[0-9WL]|787|B78[0-9X]|A33[0-9X]|A35[0-9KX]|A310|A3ST|A30[0-9B]|MD11|IL96|DC10|L101/, 'widebody'],
  // CL65 is the CRJ-100/200; the Challenger CL30/CL35/CL60 stay with the bizjets.
  [/CRJ|CL65|ERJ|EMB1[0-9][0-9]|E1(3[05]|4[05]|70|75|90|95)|E29[05]|E75[LS]|E45X|ARJ2|AJ27|SSJ|SU95|RRJ|F70|F100|FOKKER(70|100)/, 'regionaljet'],
  [/737|B73[0-9HMS]|B3[789]M|757|B75[0-9]|A31[89]|A32[01]|A(19|20|21)N|MD8[0-9]|MD9[0-9]|717|B71[0-9]|727|B72[0-9]|A22[0-9]|BCS[0-9]|CS[13]00/, 'narrowbody'],
  // Light pistons (PA-28, C172, SR22) land here too: a straight-wing, propellered
  // shape is the honest silhouette for them, and the badge only needs a rough read.
  [/DHC[678]|DH8|Q[234]00|DASH[78]|ATR[47]|AT[457][0-9]|SF34|SAAB|B190|1900|BE(19|20|9)|C90|KINGAIR|B350|PC12|C208|CARAVAN|TWINOTTER|D[23]28|\bF27|\bF50|FOKKER[25]|L410|MU2|SW4|METRO|JS3[0-9]|JETSTREAM|CN235|C295|C130|TBM|PA4[26]|PA(1[128]|2[2468]|3[248])|C1[5789][0-9]|SR2[02]|DA4[02]|BE3[36]|CIRRUS|CHEROKEE|SKYHAWK/, 'turboprop'],
  [/CITATION|C25[0-9A-Z]|C5(25|50|60|6X)|C6[08][0-9A]|C7[05]0|FALCON|FA[0-9]|F2TH|F900|DASSAULT|GULFSTREAM|GLF[0-9]|G[1-8][05]0|GLEX|GL[57]T|GLOBAL|LEAR|LJ[0-9]|CHALLENGER|CL[36][05]|BD[17]00|PHENOM|E5[05]P|LEGACY|PRAETOR|HAWKER|H25[ABC]|HS25|BE40|PREMIER|HONDA|HDJT|ECLIPSE|EA50|SF50|VISION|WW24|GALX/, 'bizjet'],
]

// The matcher ships alongside the component it feeds; that costs this file fast refresh.
// eslint-disable-next-line react-refresh/only-export-components
export function aircraftFamily(type: string | null | undefined): AircraftFamily {
  const token = (type ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!token) return 'generic'
  for (const [pattern, family] of patterns) {
    if (pattern.test(token)) return family
  }
  return 'generic'
}

/** Plan-view shapes, nose up, drawn on a 64x64 grid. Silhouettes only — the differences
 *  that survive at 28px are span, sweep and where the engines sit, so those carry the read. */
function shapeFor(family: AircraftFamily) {
  switch (family) {
    case 'quadjet':
      return (
        <>
          <path d="M32 3c3.4 0 5.6 4.4 5.8 9.6.2 4.8.2 9.9 0 14.8L37 50l-1.6 10h-6.8L27 50l-.8-22.6c-.2-4.9-.2-10 0-14.8C26.4 7.4 28.6 3 32 3z" />
          <path d="M28 22 1 45v6l27-9z" />
          <path d="M36 22l27 23v6l-27-9z" />
          <path d="M28.5 50 14 58.5V62l14.5-4.5z" />
          <path d="M35.5 50 50 58.5V62l-14.5-4.5z" />
          <rect x="15.8" y="27" width="6.4" height="13" rx="3.2" />
          <rect x="6.8" y="34.5" width="6.4" height="12" rx="3.2" />
          <rect x="41.8" y="27" width="6.4" height="13" rx="3.2" />
          <rect x="50.8" y="34.5" width="6.4" height="12" rx="3.2" />
        </>
      )
    case 'widebody':
      return (
        <>
          <path d="M32 3c2.9 0 5 4 5 9v38l-1.8 10h-6.4L27 50V12c0-5 2.1-9 5-9z" />
          <path d="M28 24 2 44v6l26-8z" />
          <path d="M36 24l26 20v6l-26-8z" />
          <path d="M28.5 49 15 58v3l13.5-4z" />
          <path d="M35.5 49 49 58v3l-13.5-4z" />
          <rect x="12.5" y="30" width="7" height="13" rx="3.5" />
          <rect x="44.5" y="30" width="7" height="13" rx="3.5" />
        </>
      )
    case 'narrowbody':
      return (
        <>
          <path d="M32 3.5c2.4 0 4.2 3.6 4.2 8.5v38l-1.5 9.5h-5.4L27.8 50V12c0-4.9 1.8-8.5 4.2-8.5z" />
          <path d="M28 26 6 44v5.5l22-7.5z" />
          <path d="M36 26l22 18v5.5l-22-7.5z" />
          <path d="M28.6 50 17 58v3l11.6-3.6z" />
          <path d="M35.4 50 47 58v3l-11.6-3.6z" />
          <rect x="16.2" y="31" width="5.6" height="11" rx="2.8" />
          <rect x="42.2" y="31" width="5.6" height="11" rx="2.8" />
        </>
      )
    case 'regionaljet':
      return (
        <>
          <path d="M32 4c2.2 0 3.8 3.4 3.8 8v38.5L34.4 60h-4.8l-1.4-9.5V12c0-4.6 1.6-8 3.8-8z" />
          <path d="M28.4 28 8 42v5l20.4-6.5z" />
          <path d="M35.6 28 56 42v5l-20.4-6.5z" />
          {/* Rear fuselage engines plus a wide stabiliser at the very tail read as a T-tail from above. */}
          <rect x="22" y="43" width="5.8" height="9.5" rx="2.9" />
          <rect x="36.2" y="43" width="5.8" height="9.5" rx="2.9" />
          <path d="M30 53 18 59v3.2l12-3.4z" />
          <path d="M34 53 46 59v3.2l-12-3.4z" />
        </>
      )
    case 'turboprop':
      return (
        <>
          <path d="M32 5c2.3 0 4 3.4 4 8v37l-1.5 9h-5L28 50V13c0-4.6 1.7-8 4-8z" />
          {/* One straight bar through the fuselage: unswept wings are the whole point here. */}
          <rect x="3" y="27" width="58" height="7" rx="3" />
          <rect x="13.5" y="20" width="6" height="17" rx="3" />
          <rect x="44.5" y="20" width="6" height="17" rx="3" />
          <ellipse cx="16.5" cy="19" rx="8" ry="1.9" />
          <ellipse cx="47.5" cy="19" rx="8" ry="1.9" />
          <rect x="19" y="52.5" width="26" height="4.5" rx="2.2" />
        </>
      )
    case 'bizjet':
      return (
        <>
          <path d="M32 6c2 0 3.4 3 3.4 7v34.5L34.2 57h-4.4l-1.2-9.5V13c0-4 1.4-7 3.4-7z" />
          <path d="M28.8 30 11 42v4.5l17.8-6z" />
          <path d="M35.2 30 53 42v4.5l-17.8-6z" />
          <rect x="22.8" y="40" width="5.2" height="8" rx="2.6" />
          <rect x="36" y="40" width="5.2" height="8" rx="2.6" />
          <path d="M30 49.5 21 55v2.8l9-2.4z" />
          <path d="M34 49.5 43 55v2.8l-9-2.4z" />
        </>
      )
    case 'generic':
      return (
        <>
          <path d="M32 4c2.3 0 4 3.4 4 8v38l-1.5 10h-5L28 50V12c0-4.6 1.7-8 4-8z" />
          <path d="M28 26 5 46v5l23-9z" />
          <path d="M36 26l23 20v5l-23-9z" />
          <path d="M28.6 51 18 58.5V61l10.6-3.4z" />
          <path d="M35.4 51 46 58.5V61l-10.6-3.4z" />
        </>
      )
  }
}

/** Header badge glyph. Inherits the badge's text colour so it follows the theme. */
export function AircraftSilhouette({
  family,
  size = 28,
  className,
}: {
  family: AircraftFamily
  size?: number
  className?: string
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {shapeFor(family)}
    </svg>
  )
}

export type ShowcaseAircraftType = 'b747' | 'b777' | 'b787' | 'b767' | 'a330' | 'a340' | 'md11' | 'a380'

/** Masked in CSS rather than inlined so the plan-view artwork picks up the dashboard text colour. */
export function ShowcaseAircraft({ type, className }: { type: ShowcaseAircraftType; className?: string }) {
  return <span className={className} data-jet={type} aria-hidden="true" />
}



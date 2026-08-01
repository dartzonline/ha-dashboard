import type { LucideIcon } from 'lucide-react'
import {
  Baby, Battery, BedDouble, Bot, BriefcaseBusiness, Car, ChartNoAxesCombined, CircleDot, CloudSun,
  DoorOpen, Droplets, Filter, Gauge, Globe2, Home, Lamp, Lightbulb, Lock, Moon, Plane, Projector, Refrigerator,
  RotateCw, ScanLine, Shield, Sparkles, Sprout, Thermometer, Tv, Warehouse, WashingMachine, Waves, Wifi, Wind, Zap,
} from 'lucide-react'

/** Keyed by the `icon` string stored in tile config, so tiles can reference an icon by name in JSON. */
export const icons: Record<string, LucideIcon> = {
  baby: Baby, battery: Battery, bed: BedDouble, bot: Bot, briefcase: BriefcaseBusiness,
  car: Car, 'circle-dot': CircleDot, 'cloud-sun': CloudSun, 'door-open': DoorOpen,
  droplets: Droplets, filter: Filter, gauge: Gauge, lamp: Lamp, lightbulb: Lightbulb, lock: Lock,
  moon: Moon, projector: Projector, refrigerator: Refrigerator, 'rotate-cw': RotateCw,
  scan: ScanLine, shield: Shield, sparkles: Sparkles, thermometer: Thermometer,
  sprout: Sprout, tv: Tv, warehouse: Warehouse, waves: Waves, 'washing-machine': WashingMachine, wifi: Wifi, wind: Wind,
}

export const sectionIcons: Record<string, LucideIcon> = {
  insights: ChartNoAxesCombined,
  home: Home,
  world: Globe2,
  flights: Plane,
  energy: Zap,
  weather: CloudSun,
  climate: Thermometer,
  security: Shield,
  lights: Lightbulb,
  appliances: WashingMachine,
  roborock: Bot,
  scenes: Sparkles,
}

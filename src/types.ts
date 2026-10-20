export type Recipe = 'corporate' | 'luxury' | 'saas'
export type AnimationLevel = 'none' | 'subtle' | 'expressive'
export type Language = 'fr' | 'en'
export type Industry =
  | 'legal'
  | 'technology'
  | 'finance'
  | 'healthcare'
  | 'education'
  | 'logistics'
  | 'real-estate'
  | 'ecommerce'
  | 'hospitality'
  | 'creative'
  | 'general'
export type BrandTone = 'professional' | 'premium' | 'bold' | 'friendly' | 'minimal'
export type ConversionGoal = 'leads' | 'bookings' | 'sales' | 'signup' | 'contact' | 'awareness'
export type SectionKind =
  | 'hero'
  | 'trust'
  | 'services'
  | 'features'
  | 'process'
  | 'testimonials'
  | 'pricing'
  | 'faq'
  | 'contact'
  | 'final-cta'

export type Cta = { label: string; href: string }
export type HeroContent = {
  eyebrow?: string
  title: string
  subtitle: string
  primaryCta: Cta
  secondaryCta?: Cta
}
export type CardItem = { title: string; description: string }
export type CardSection = {
  eyebrow: string
  title: string
  items: CardItem[]
}
export type TrustSection = {
  eyebrow: string
  title: string
  items: Array<{ value: string; label: string }>
}
export type ProcessSection = {
  eyebrow: string
  title: string
  steps: CardItem[]
}
export type FaqSection = {
  eyebrow: string
  title: string
  items: Array<{ question: string; answer: string }>
}
export type ContactSection = {
  eyebrow: string
  title: string
  description: string
  cta: Cta
}
export type FinalCta = {
  title: string
  subtitle?: string
  label: string
  href: string
}

export type AppFactoryManifest = {
  schemaVersion: 2
  project: {
    name: string
    slug: string
    language: Language
  }
  strategy: {
    brief: string
    audience: string | null
    industry: Industry
    tone: BrandTone
    goal: ConversionGoal
  }
  brand: {
    tone: BrandTone
    palette: 'navy-mint' | 'midnight-gold' | 'electric-indigo'
    typography: 'grotesk' | 'editorial' | 'geometric'
  }
  design: {
    recipe: Recipe
    animation: AnimationLevel
    density: 'airy' | 'balanced'
  }
  sections: SectionKind[]
  seo: {
    title: string
    description: string
  }
  motion: {
    level: AnimationLevel
    respectReducedMotion: boolean
  }
  content: {
    hero: HeroContent
    trust: TrustSection
    services: CardSection
    features: CardSection
    process: ProcessSection
    faq: FaqSection
    contact: ContactSection
    finalCta: FinalCta
  }
  // Compatibility fields for projects generated before the modular renderer.
  hero: HeroContent
  features: CardItem[]
  finalCta: FinalCta
}

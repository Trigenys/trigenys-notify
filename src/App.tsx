import { manifest } from './config'
import { Hero } from './sections/Hero'
import { FinalCta } from './sections/FinalCta'
import {
  CardSection,
  ContactSection,
  FaqSection,
  ProcessSection,
  TrustSection
} from './sections/DynamicSections'
import type { SectionKind } from './types'

function renderSection(section: SectionKind) {
  switch (section) {
    case 'hero':
      return <Hero manifest={manifest} />
    case 'trust':
      return <TrustSection config={manifest.content.trust} />
    case 'services':
      return <CardSection config={manifest.content.services} kind="services" />
    case 'features':
      return <CardSection config={manifest.content.features} kind="features" />
    case 'process':
      return <ProcessSection config={manifest.content.process} />
    case 'faq':
      return <FaqSection config={manifest.content.faq} />
    case 'contact':
      return <ContactSection config={manifest.content.contact} />
    case 'final-cta':
      return <FinalCta config={manifest.content.finalCta} language={manifest.project.language} />
    case 'testimonials':
    case 'pricing':
      return null
  }
}

export default function App() {
  return (
    <main
      className={`site recipe-${manifest.design.recipe} palette-${manifest.brand.palette} typography-${manifest.brand.typography} density-${manifest.design.density} motion-${manifest.motion.level}`}
    >
      {manifest.sections.map((section) => (
        <div className={`section-slot section-slot-${section}`} key={section}>
          {renderSection(section)}
        </div>
      ))}
    </main>
  )
}

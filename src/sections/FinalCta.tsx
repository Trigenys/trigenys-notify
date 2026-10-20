import type { AppFactoryManifest } from '../types'

export function FinalCta({
  config,
  language
}: {
  config: AppFactoryManifest['content']['finalCta']
  language: AppFactoryManifest['project']['language']
}) {
  return (
    <section className="cta-shell" id="final-cta">
      <div>
        <p className="eyebrow">{language === 'fr' ? 'À vous' : 'Ready'}</p>
        <h2>{config.title}</h2>
        {config.subtitle && <p>{config.subtitle}</p>}
      </div>
      <a className="button button-primary" href={config.href}>
        {config.label}
      </a>
    </section>
  )
}

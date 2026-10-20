import type { AppFactoryManifest } from '../types'

function industryLabel(
  industry: AppFactoryManifest['strategy']['industry'],
  language: AppFactoryManifest['project']['language']
) {
  const labels = {
    legal: { fr: 'Conseil juridique', en: 'Legal counsel' },
    technology: { fr: 'Technologie', en: 'Technology' },
    finance: { fr: 'Services financiers', en: 'Financial services' },
    healthcare: { fr: 'Santé', en: 'Healthcare' },
    education: { fr: 'Éducation', en: 'Education' },
    logistics: { fr: 'Logistique', en: 'Logistics' },
    'real-estate': { fr: 'Immobilier', en: 'Real estate' },
    ecommerce: { fr: 'Commerce', en: 'Commerce' },
    hospitality: { fr: 'Hospitalité', en: 'Hospitality' },
    creative: { fr: 'Création', en: 'Creative work' },
    general: { fr: 'Services', en: 'Services' }
  }
  return labels[industry][language]
}

function goalLabel(goal: AppFactoryManifest['strategy']['goal'], language: AppFactoryManifest['project']['language']) {
  const labels = {
    leads: { fr: 'Générer des demandes', en: 'Generate leads' },
    bookings: { fr: 'Prise de rendez-vous', en: 'Book consultations' },
    sales: { fr: 'Conversion', en: 'Drive sales' },
    signup: { fr: 'Inscription', en: 'Drive signups' },
    contact: { fr: 'Prise de contact', en: 'Start conversations' },
    awareness: { fr: 'Notoriété', en: 'Build awareness' }
  }
  return labels[goal][language]
}

export function Hero({ manifest }: { manifest: AppFactoryManifest }) {
  const config = manifest.content.hero
  const { project, strategy, design } = manifest
  const supportingCards = manifest.sections.includes('services')
    ? manifest.content.services.items
    : manifest.content.features.items

  return (
    <section className={`hero-shell hero-${design.recipe}`}>
      <nav className="nav-shell">
        <strong>{project.name}</strong>
        <div className="nav-links">
          <a href="#capabilities">Expertise</a>
          <a href="#contact">Contact</a>
        </div>
      </nav>

      <div className="hero-grid">
        <div className="hero-copy">
          {config.eyebrow && <p className="eyebrow">{config.eyebrow}</p>}
          <h1>{config.title}</h1>
          <p className="hero-subtitle">{config.subtitle}</p>
          <div className="hero-actions">
            <a className="button button-primary" href={config.primaryCta.href}>
              {config.primaryCta.label}
            </a>
            {config.secondaryCta && (
              <a className="button button-secondary" href={config.secondaryCta.href}>
                {config.secondaryCta.label}
              </a>
            )}
          </div>
        </div>

        {design.recipe === 'luxury' && (
          <aside
            className="hero-visual hero-editorial"
            aria-label={project.language === 'fr' ? 'Positionnement' : 'Positioning'}
          >
            <div className="editorial-monogram">{project.name.slice(0, 2).toUpperCase()}</div>
            <div className="editorial-rule" />
            <p>{project.language === 'fr' ? 'Positionnement' : 'Positioning'}</p>
            <strong>{industryLabel(strategy.industry, project.language)}</strong>
            <dl>
              <div>
                <dt>{project.language === 'fr' ? 'Public' : 'Audience'}</dt>
                <dd>{strategy.audience || (project.language === 'fr' ? 'Clients exigeants' : 'Discerning clients')}</dd>
              </div>
              <div>
                <dt>{project.language === 'fr' ? 'Objectif' : 'Goal'}</dt>
                <dd>{goalLabel(strategy.goal, project.language)}</dd>
              </div>
            </dl>
          </aside>
        )}

        {design.recipe === 'saas' && (
          <aside
            className="hero-visual hero-product"
            aria-label={project.language === 'fr' ? 'Aperçu produit' : 'Product preview'}
          >
            <div className="product-topbar">
              <span />
              <span />
              <span />
            </div>
            <div className="product-command">{project.name}</div>
            <div className="product-grid">
              {supportingCards.slice(0, 3).map((item, index) => (
                <div className="product-card" key={item.title}>
                  <span>0{index + 1}</span>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                </div>
              ))}
            </div>
          </aside>
        )}

        {design.recipe === 'corporate' && (
          <aside
            className="hero-visual hero-corporate"
            aria-label={project.language === 'fr' ? 'Capacités clés' : 'Key capabilities'}
          >
            <p className="hero-visual-kicker">{project.language === 'fr' ? 'Priorités' : 'Priorities'}</p>
            {supportingCards.slice(0, 3).map((item, index) => (
              <div className="corporate-row" key={item.title}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                </div>
              </div>
            ))}
          </aside>
        )}
      </div>
    </section>
  )
}

import type {
  CardSection as CardSectionConfig,
  ContactSection as ContactSectionConfig,
  FaqSection as FaqSectionConfig,
  ProcessSection as ProcessSectionConfig,
  TrustSection as TrustSectionConfig
} from '../types'

export function TrustSection({ config }: { config: TrustSectionConfig }) {
  return (
    <section className="content-section trust-section" id="trust">
      <div className="section-heading split-heading">
        <p className="eyebrow">{config.eyebrow}</p>
        <h2>{config.title}</h2>
      </div>
      <div className="trust-grid">
        {config.items.map((item) => (
          <article className="trust-item" key={item.value}>
            <strong>{item.value}</strong>
            <p>{item.label}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

export function CardSection({
  config,
  kind
}: {
  config: CardSectionConfig
  kind: 'services' | 'features'
}) {
  return (
    <section className={`content-section card-section card-section-${kind}`} id="capabilities">
      <div className="section-heading">
        <p className="eyebrow">{config.eyebrow}</p>
        <h2>{config.title}</h2>
      </div>
      <div className="modular-card-grid">
        {config.items.map((item, index) => (
          <article className="modular-card" key={`${item.title}-${index}`}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <div>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

export function ProcessSection({ config }: { config: ProcessSectionConfig }) {
  return (
    <section className="content-section process-section" id="process">
      <div className="section-heading">
        <p className="eyebrow">{config.eyebrow}</p>
        <h2>{config.title}</h2>
      </div>
      <div className="process-list">
        {config.steps.map((step, index) => (
          <article className="process-step" key={`${step.title}-${index}`}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <h3>{step.title}</h3>
            <p>{step.description}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

export function FaqSection({ config }: { config: FaqSectionConfig }) {
  return (
    <section className="content-section faq-section" id="faq">
      <div className="section-heading">
        <p className="eyebrow">{config.eyebrow}</p>
        <h2>{config.title}</h2>
      </div>
      <div className="faq-list">
        {config.items.map((item, index) => (
          <details className="faq-item" key={`${item.question}-${index}`} open={index === 0}>
            <summary>{item.question}</summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  )
}

export function ContactSection({ config }: { config: ContactSectionConfig }) {
  return (
    <section className="content-section contact-section" id="contact">
      <div className="contact-panel">
        <div>
          <p className="eyebrow">{config.eyebrow}</p>
          <h2>{config.title}</h2>
          <p>{config.description}</p>
        </div>
        <a className="button button-primary" href={config.cta.href}>
          {config.cta.label}
        </a>
      </div>
    </section>
  )
}

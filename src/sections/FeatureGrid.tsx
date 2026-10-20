import type { AppFactoryManifest } from '../types'

export function FeatureGrid({ items }: { items: AppFactoryManifest['features'] }) {
  return (
    <section className="content-section">
      <div className="section-heading">
        <p className="eyebrow">Why it works</p>
        <h2>Built from a controlled system, not a blank canvas.</h2>
      </div>
      <div className="feature-grid">
        {items.map((item, index) => (
          <article className="feature-card" key={`${item.title}-${index}`}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <h3>{item.title}</h3>
            <p>{item.description}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

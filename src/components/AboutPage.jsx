// Shared About page — the tenant's about_*, bio_* and framework_* content rendered as a
// full page. Used by the client "About" tab and the coach /coach/about preview. Every
// section is null-safe: unset fields disappear so a sparse config still looks intentional.
import FrameworkMedia from "./FrameworkMedia";

export default function AboutPage({ branding, emptyHint }) {
  if (!branding) return <p className="mt-6 text-sm opacity-60">Loading…</p>;
  const {
    coach_display_name, about_headline, about_body, about_photo_url,
    bio_body, bio_photo_url, framework_name, framework_body, framework_media_url,
  } = branding;
  const empty = !about_headline && !about_body && !about_photo_url && !bio_body && !framework_body;
  if (empty) {
    return (
      <p className="glass mt-6 px-4 py-3 text-sm opacity-60">
        {emptyHint || "Your coach hasn’t added their story yet."}
      </p>
    );
  }
  return (
    <div className="mt-6 space-y-6">
      {(about_headline || about_body || about_photo_url) && (
        <section className="glass p-5">
          <span className="kicker">About {coach_display_name || "your coach"}</span>
          {about_headline && <h2 className="display mt-1 text-xl sm:text-2xl">{about_headline}</h2>}
          <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start">
            {about_photo_url && (
              <img src={about_photo_url} alt={coach_display_name || "Coach"}
                className="h-40 w-40 shrink-0 rounded-2xl object-cover" />
            )}
            {about_body && <p className="whitespace-pre-line text-sm leading-relaxed opacity-80">{about_body}</p>}
          </div>
        </section>
      )}

      {(bio_body || bio_photo_url) && (
        <section className="glass p-5">
          <h3 className="section-title">Background</h3>
          <div className="mt-3 flex flex-col gap-5 sm:flex-row sm:items-start">
            {bio_photo_url && (
              <img src={bio_photo_url} alt="" className="h-32 w-32 shrink-0 rounded-2xl object-cover" />
            )}
            {bio_body && <p className="whitespace-pre-line text-sm leading-relaxed opacity-80">{bio_body}</p>}
          </div>
        </section>
      )}

      {(framework_name || framework_body || framework_media_url) && (
        <section className="glass p-5">
          <h3 className="section-title">The method</h3>
          {framework_name && <h4 className="display mt-1 text-xl">{framework_name}</h4>}
          {framework_body && <p className="mt-3 whitespace-pre-line text-sm leading-relaxed opacity-80">{framework_body}</p>}
          <FrameworkMedia url={framework_media_url} />
        </section>
      )}
    </div>
  );
}

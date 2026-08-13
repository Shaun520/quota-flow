export function PrototypePage({ html }: { html: string }) {
  return <div className="prototype-page" dangerouslySetInnerHTML={{ __html: html }} />;
}

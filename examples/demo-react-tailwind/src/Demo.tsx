// Authored static input only; not a runnable website.
export function Demo({ tone }: { tone: string }) {
  return <section>
    <button className="bg-blue-600 text-white rounded-md">Primary CTA A</button>
    <button className="bg-red-600 text-white rounded-xl">Primary CTA B</button>
    <span className="bg-[#123456] text-[#234567] rounded-full">Semantic bypass</span>
    <span className={`bg-${tone}`}>Dynamic UNKNOWN</span>
  </section>;
}

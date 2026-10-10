export function Badge({ tone }: { tone: string }) {
  return <span className={`bg-${tone} text-[#123456] p-3`}>Static input</span>;
}

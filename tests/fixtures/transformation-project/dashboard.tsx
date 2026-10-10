import { Button as Action, Card as Panel } from "./components";
export function Dashboard() {
  return <article data-page="dashboard" className="bg-white text-black">
    <section data-region="intro" className="bg-gradient-to-br from-teal-100 to-cyan-100 py-16">
      <p className="text-teal-700">An independent static fixture</p>
      <Action>Continue</Action><Action variant="secondary">Details</Action>
      <Panel id="editor" className="shadow-2xl"><h2>Editor</h2></Panel>
    </section>
    <section data-region="details" className="py-16"><Panel><p className="text-muted-foreground">A feature</p></Panel></section>
    <section data-region="invitation" className="pb-16"><Panel className="bg-gradient-to-r from-teal-700 to-cyan-700 text-white p-8"><h2>Invitation</h2></Panel></section>
  </article>;
}

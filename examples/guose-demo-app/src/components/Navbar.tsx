export function Navbar() {
  return <header data-region="navbar" className="border-b border-indigo-100 bg-white text-slate-900">
    <nav aria-label="主导航" className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-5">
      <a href="#home" className="text-xl font-bold text-indigo-700 focus-visible:outline-2">Flowboard</a>
      <div className="flex gap-6 text-sm font-medium">
        <a href="#features" className="hover:text-indigo-700 focus-visible:outline-2">功能</a>
        <a href="#workspace" className="hover:text-indigo-700 focus-visible:outline-2">体验工作区</a>
      </div>
    </nav>
  </header>;
}

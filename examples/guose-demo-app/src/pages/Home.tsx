import { useState, type FormEvent } from "react";
import { Navbar } from "../components/Navbar";
import { Footer } from "../components/Footer";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";

const features = [
  { title: "收集下一步", body: "把零散想法写成具体任务。工作区只保留当前会话中的内容。", label: "01 / CAPTURE" },
  { title: "看清优先级", body: "先整理要做的事，再决定先完成哪一件。示例任务可直接勾选。", label: "02 / FOCUS" },
  { title: "按节奏推进", body: "用完成状态追踪进展，让每一个小步骤都有清晰的反馈。", label: "03 / PROGRESS" },
];
const starterTasks = [
  { id: 1, title: "整理本周项目想法", done: false },
  { id: 2, title: "确认下一次协作议题", done: true },
  { id: 3, title: "写下一个可执行步骤", done: false },
];

export function Home() {
  const [tasks, setTasks] = useState(starterTasks);
  const [title, setTitle] = useState("");
  const [notice, setNotice] = useState("");
  const completed = tasks.filter((task) => task.done).length;
  function addTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = title.trim();
    if (!value) { setNotice("请输入任务名称。"); return; }
    setTasks((current) => [...current, { id: Math.max(...current.map((task) => task.id)) + 1, title: value, done: false }]);
    setTitle("");
    setNotice("任务已添加；刷新页面将恢复示例。");
  }
  function openWorkspace() {
    document.getElementById("workspace")?.scrollIntoView({ behavior: "auto", block: "center" });
    document.getElementById("task-title")?.focus();
  }
  return <div id="home">
    <Navbar />
    <main data-page="home" data-transform-scope="home-visual" className="bg-background text-foreground">
      <section data-region="hero" className="bg-gradient-to-br from-indigo-100 via-purple-100 to-blue-100 px-6 py-20">
        <div className="mx-auto grid max-w-6xl items-center gap-12 md:grid-cols-2">
          <div>
            <p className="mb-5 inline-flex rounded-full bg-white px-4 py-2 text-sm font-semibold text-indigo-700 shadow-sm">你的下一步，一目了然</p>
            <h1 className="text-4xl font-bold leading-tight sm:text-5xl">把想法变成<br /><span className="text-indigo-700">有序的行动。</span></h1>
            <p className="mt-6 max-w-lg text-lg leading-8 text-muted-foreground">一个轻量的协作工作区。从收集任务到完成下一步，让项目推进更清晰。</p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Button onClick={openWorkspace}>开始体验</Button>
              <Button variant="secondary" onClick={() => document.getElementById("features")?.scrollIntoView()}>了解功能</Button>
            </div>
            <p className="mt-5 text-sm text-muted-foreground">本地演示 · 无账号、无业务网络请求、无数据持久化</p>
          </div>
          <Card id="workspace" className="shadow-2xl shadow-indigo-200">
            <div className="mb-6 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">本周工作区</h2>
              <span className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-secondary-foreground">{completed} / {tasks.length} 已完成</span>
            </div>
            <ul className="space-y-3">
              {tasks.map((task) => <li key={task.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl bg-muted px-4 py-3">
                  <input type="checkbox" checked={task.done} onChange={() => setTasks((current) => current.map((item) => item.id === task.id ? { ...item, done: !item.done } : item))} className="h-4 w-4 accent-indigo-700" />
                  <span className={task.done ? "text-muted-foreground line-through" : "text-foreground"}>{task.title}</span>
                </label>
              </li>)}
            </ul>
            <form onSubmit={addTask} className="mt-6 space-y-3">
              <label htmlFor="task-title" className="block text-sm font-medium">添加下一步</label>
              <input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="写下一个具体任务" className="min-h-11 w-full rounded-xl border border-border bg-white px-4 py-3 text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              <Button type="submit" className="w-full">添加任务</Button>
              <p role="status" className="min-h-5 text-xs text-muted-foreground">{notice}</p>
            </form>
          </Card>
        </div>
      </section>
      <section id="features" data-region="features" className="px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <div className="mb-10 text-center">
            <p className="text-sm font-semibold text-indigo-700">简单流程，清晰反馈</p>
            <h2 className="mt-3 text-3xl font-bold">从想法到下一步</h2>
            <p className="mt-4 text-muted-foreground">三个步骤，保持工作有序；不增加额外的管理负担。</p>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {features.map((feature) => <Card key={feature.title}>
              <p className="text-xs font-bold text-indigo-700">{feature.label}</p>
              <h3 className="mt-5 text-xl font-semibold">{feature.title}</h3>
              <p className="mt-4 leading-7 text-muted-foreground">{feature.body}</p>
            </Card>)}
          </div>
        </div>
      </section>
      <section data-region="cta" className="px-6 pb-20">
        <Card className="mx-auto max-w-6xl bg-gradient-to-r from-indigo-700 to-purple-700 p-10 text-white">
          <h2 className="text-3xl font-bold">现在，写下你的下一步。</h2>
          <p className="mt-4 max-w-xl leading-7 text-indigo-100">在上方工作区试着添加一个任务。内容只用于演示，刷新后恢复默认示例。</p>
          <Button variant="secondary" onClick={openWorkspace} className="mt-7">体验本地工作区</Button>
        </Card>
      </section>
    </main>
    <Footer />
  </div>;
}

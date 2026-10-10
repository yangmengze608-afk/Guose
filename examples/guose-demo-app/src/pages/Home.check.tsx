import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Home } from "./Home";

afterEach(cleanup);
describe("trusted demo baseline", () => {
  it("keeps the page skeleton and protected regions explicit", () => {
    const { container } = render(<Home />);
    expect([...container.querySelectorAll("[data-region]")].map((node) => node.getAttribute("data-region"))).toEqual(["navbar", "hero", "features", "cta", "footer"]);
    expect(container.querySelectorAll("#features [data-slot=card]")).toHaveLength(3);
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
  });
  it("updates completed task count without network or persistence", async () => {
    render(<Home />);
    await userEvent.click(screen.getByRole("checkbox", { name: "整理本周项目想法" }));
    expect(screen.getByText("2 / 3 已完成")).toBeTruthy();
  });
  it("adds a real local task and clears the input", async () => {
    render(<Home />);
    await userEvent.type(screen.getByLabelText("添加下一步"), "阅读设计提案");
    await userEvent.click(screen.getByRole("button", { name: "添加任务" }));
    expect(screen.getByRole("checkbox", { name: "阅读设计提案" })).toBeTruthy();
    expect(screen.getByText("1 / 4 已完成")).toBeTruthy();
    expect((screen.getByLabelText("添加下一步") as HTMLInputElement).value).toBe("");
  });
  it("rejects blank tasks and preserves the list", async () => {
    render(<Home />);
    await userEvent.click(screen.getByRole("button", { name: "添加任务" }));
    expect(screen.getByRole("status").textContent).toBe("请输入任务名称。");
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });
});

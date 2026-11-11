import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Select } from "../src/components/Select.tsx";

function Fixture() {
  const [value, setValue] = useState("a");
  return <><Select aria-label="测试选择" value={value} onChange={setValue} options={[
    { value: "a", label: "甲" }, { value: "b", label: "不可选", disabled: true }, { value: "c", label: "丙" },
  ]} /><output>{value}</output><button>外部</button></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

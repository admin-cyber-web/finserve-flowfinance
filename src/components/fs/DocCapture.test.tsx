import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { DocCapture, DocItem } from "./DocCapture";

describe("DocCapture", () => {
  it("renders document type selector, camera and upload buttons", () => {
    const items: DocItem[] = [];
    const { container } = render(
      <DocCapture label="Aadhaar Photo" value={items} setValue={() => {}} />
    );
    expect(container.querySelector("select")).toBeInTheDocument();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(2);
  });
});

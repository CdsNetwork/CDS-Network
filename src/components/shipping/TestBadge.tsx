/** Marks a ShipStation test label: not shippable, no charge. */
export function TestBadge() {
  return (
    <span className="tag" style={{ background: "#fff8e5", color: "#7a5200", border: "1px solid #f5d788" }} title="Test label: not shippable, no charge">
      TEST LABEL
    </span>
  );
}

export function Brand({ subtitle }: { subtitle: string }) {
  return (
    <div className="logo">
      <div className="mark">CDS</div>
      <div>
        Clean Diesel Specialists
        <small>{subtitle}</small>
      </div>
    </div>
  );
}

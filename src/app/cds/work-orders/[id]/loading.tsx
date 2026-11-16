// Shown while the work order loads, so a click from the list shows something right away.
export default function WorkOrderLoading() {
  return (
    <div className="section small" role="status" aria-live="polite">
      Loading the work order...
    </div>
  );
}

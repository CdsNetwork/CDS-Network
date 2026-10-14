import { signOut } from "@/app/login/actions";

export function SignOutButton() {
  return (
    <form action={signOut}>
      <button className="btn btn-secondary btn-small" type="submit">
        Sign out
      </button>
    </form>
  );
}

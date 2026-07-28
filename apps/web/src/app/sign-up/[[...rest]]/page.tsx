import { SignUp } from '@clerk/nextjs';

export default function SignUpPage(): React.ReactElement {
  return (
    <main>
      <h1>Inscription</h1>
      <SignUp />
    </main>
  );
}

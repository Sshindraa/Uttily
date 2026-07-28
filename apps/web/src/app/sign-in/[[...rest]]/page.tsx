import { SignIn } from '@clerk/nextjs';

export default function SignInPage(): React.ReactElement {
  return (
    <main>
      <h1>Connexion</h1>
      <SignIn />
    </main>
  );
}

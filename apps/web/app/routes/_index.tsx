import { Link } from 'react-router';

export default function Index() {
  return (
    <>
      <header className="site-header">
        <nav className="container" aria-label="Main">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden="true" />
            AccountDrop
          </Link>
          <Link to="/login" className="nav-end">
            Sign in
          </Link>
        </nav>
      </header>
      <main id="main" className="container">
        <section className="hero">
          <h1>
            Your reps WhatsApp the form. Credit control gets a complete, readable application.
          </h1>
          <p>
            A rep photographs the signed trade-account form and sends it to a WhatsApp number.
            AccountDrop reads it, asks the rep for anything missing, checks the company on Companies
            House, and hands credit control a clean application with the original image attached.
            Accounts open in hours, not days.
          </p>
          <p>
            <Link className="button" to="/login">
              Sign in to the review queue
            </Link>
          </p>
        </section>
      </main>
    </>
  );
}

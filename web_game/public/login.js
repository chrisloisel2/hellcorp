const form = document.getElementById("login-form");
const errorEl = document.getElementById("error");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.hidden = true;

  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (res.ok) {
    window.location.href = "/game.html";
    return;
  }

  const data = await res.json().catch(() => ({}));
  errorEl.textContent = data.error === "invalid credentials"
    ? "Identifiant ou mot de passe incorrect."
    : "Connexion impossible.";
  errorEl.hidden = false;
});

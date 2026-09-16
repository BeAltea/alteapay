import { contact } from "@/content/home"
import { ContactFormLazy as ContactForm } from "./contact-form-lazy"

/**
 * Secao de contato (server): titulo e texto renderizados no servidor;
 * o formulario (client, react-hook-form) fica em contact-form.tsx e carrega
 * em chunk proprio via contact-form-lazy.tsx.
 */
export function Contact() {
  return (
    <section
      id="contato"
      aria-labelledby="contato-title"
      className="scroll-mt-16 bg-gray-50 py-12 text-altea-navy sm:py-16 lg:py-20"
    >
      <div className="container mx-auto max-w-6xl px-4">
        <div className="mx-auto max-w-2xl">
          <h2 id="contato-title" className="text-center text-3xl font-bold text-altea-navy sm:text-4xl">
            {contact.h2}
          </h2>
          <p className="mt-4 text-center text-lg text-gray-600">{contact.intro}</p>
          <ContactForm />
        </div>
      </div>
    </section>
  )
}

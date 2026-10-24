/**
 * The shell's neutral Terms of use and Privacy notice (mold_v0-109): one template for every app, in the build's words.
 * Two kinds of placeholder, filled in this order (web/src/features/site/legal.tsx):
 *
 *   {product} {account} {Workspaces} ...   the build's words (web/src/lib/vocabulary.ts fill), "a {account}" takes its article
 *   [company] [contact] [jurisdiction]     the app's profile.json `legal` (src/legal.ts): shown as text, the contact as a
 *   [effective_date] [terms] [privacy]     mailto: link, [terms] and [privacy] as links to the other page
 *
 * The facts are put in after the words, so nothing a profile writes is ever read as a placeholder. A paragraph that
 * `needs` a fact the profile leaves out (the jurisdiction) is not shown. No product's words: the build's own come from
 * its profile and packs. A company that has its own terms or privacy notice sets terms_url or privacy_url instead.
 */

export interface LegalParagraph { text: string; needs?: 'jurisdiction' }
export interface LegalSection { heading: string; paragraphs?: LegalParagraph[]; items?: LegalParagraph[] }
export interface LegalDoc { title: string; intro: LegalParagraph[]; sections: LegalSection[] }

const p = (text: string, needs?: LegalParagraph['needs']): LegalParagraph => (needs ? { text, needs } : { text });

export const TERMS: LegalDoc = {
  title: 'Terms of use',
  intro: [
    p('These terms apply to {product}, a service offered by [company] ("we", "us"). They take effect on [effective_date].'),
    p('Please read them before you use {product}. How we handle personal data is described in our [privacy].')
  ],
  sections: [
    {
      heading: 'Agreeing to these terms',
      paragraphs: [
        p('By opening a {account}, accepting an invitation to a {workspace} or using {product}, you agree to these terms. If you do not agree, do not use {product}.'),
        p('If you use {product} for an organisation, you agree to these terms for it and confirm that you may do so.')
      ]
    },
    {
      heading: 'Your {account} and {workspace}',
      paragraphs: [
        p('You are responsible for what is done with your sign-in and your {keys}. Keep them private, and write to [contact] at once if you think someone else has used them.'),
        p('The {owners} of a {workspace} decide who joins it and what each {member} may do there.')
      ]
    },
    {
      heading: 'Your content',
      paragraphs: [
        p('What you and your {members} put into {product}, and the results of the {runs} you start, remain yours. You allow [company] to store, process and show it only as needed to provide {product} to you, to keep it secure and to meet the law.'),
        p('You are responsible for having the right to use what you put into {product}.')
      ]
    },
    {
      heading: 'Acceptable use',
      items: [
        p('Do not use {product} to break the law or anyone else\'s rights.'),
        p('Do not reach, or try to reach, data or systems you are not allowed to reach, including other {workspaces}.'),
        p('Do not disrupt the service, get around its limits or sign-in, or send spam or malicious code through it.')
      ]
    },
    {
      heading: 'AI clients and automated work',
      paragraphs: [
        p('{Product} can be used from AI assistants and other MCP clients, and can carry out {runs} for you. Results produced by automated tools can be incomplete or wrong: check them before you rely on them.'),
        p('You are responsible for the clients you connect and for what they do with the access you give them.')
      ]
    },
    {
      heading: 'Plans and fees',
      paragraphs: [p('If a plan of {product} has a price, the price and what the plan includes are shown before you choose it. Fees are not refundable unless the plan or the law says otherwise.')]
    },
    {
      heading: 'Changes and suspension',
      paragraphs: [
        p('We may change {product} and these terms. When a change to these terms matters, we will tell the {owners} of the {accounts} it affects before it takes effect. Using {product} after that means you accept the change.'),
        p('We may suspend access that breaks these terms or puts the service or other people at risk.')
      ]
    },
    {
      heading: 'Ending',
      paragraphs: [p('You can stop using {product} at any time. An {owner} can ask us to close their {account} by writing to [contact].')]
    },
    {
      heading: 'Warranties and liability',
      paragraphs: [
        p('{Product} is provided as it is and as available. As far as the law allows, [company] does not promise that it will be uninterrupted or free of errors, and is not liable for indirect or consequential loss, or for lost profits, revenue or data.'),
        p('Nothing in these terms limits a liability that the law does not allow to be limited.')
      ]
    },
    {
      heading: 'Governing law',
      paragraphs: [p('These terms are governed by the law of [jurisdiction], and the courts of [jurisdiction] decide any dispute about them, unless the law where you live gives you another choice.', 'jurisdiction')]
    },
    {
      heading: 'Contact',
      paragraphs: [p('Questions about these terms: [contact].')]
    }
  ]
};

export const PRIVACY: LegalDoc = {
  title: 'Privacy notice',
  intro: [
    p('This notice explains what personal data [company] handles when you use {product}, why, and the choices you have. It takes effect on [effective_date].'),
    p('The rules for using {product} are in our [terms].')
  ],
  sections: [
    {
      heading: 'Who is responsible',
      paragraphs: [
        p('[company] is responsible for the personal data described here. Write to [contact] with any question or request about it.'),
        p('For the content a {workspace} puts into {product}, the organisation that owns the {workspace} decides what goes in, and we handle it on that organisation\'s behalf.')
      ]
    },
    {
      heading: 'What we collect',
      items: [
        p('Your sign-in details: your name, your email address and, if you sign in with another provider, the identifier it gives us.'),
        p('What you do in {product}: the {workspaces} you belong to, your role, the {runs} you start and the {tool_calls} your AI clients make (which tool, when, and whether it worked).'),
        p('What you put in: the records, files and settings you and your {members} add, and the results of {runs}.'),
        p('Technical data: network addresses, browser and client type, and error reports.')
      ]
    },
    {
      heading: 'Why we use it',
      items: [
        p('To provide {product} to you, sign you in and keep your {account} secure.'),
        p('To send the emails the service needs, such as sign-in codes, invitations and the notices you ask for.'),
        p('To show your {workspace} its own activity, and to understand, fix and improve the service.'),
        p('To meet our legal obligations.')
      ],
      paragraphs: [p('We do not sell personal data.')]
    },
    {
      heading: 'Who we share it with',
      items: [
        p('Service providers that host, store, email or process data for us, who may use it only to provide their service to us.'),
        p('AI model providers: when a {run} or an assistant uses a model, the data it needs is sent to that model\'s provider to produce the answer.'),
        p('The other {members} of your {workspace}, who see what the {workspace} shares.'),
        p('Authorities, when the law requires it.')
      ]
    },
    {
      heading: 'How long we keep it',
      paragraphs: [p('As long as your {account} is open, and after that only as long as the law, or settling a dispute, requires. Activity records are kept for a limited period, for security and billing.')]
    },
    {
      heading: 'How we protect it',
      paragraphs: [p('Each {workspace}\'s data is kept apart from every other {workspace}\'s, data travels over encrypted connections, and only the people who need to can reach it.')]
    },
    {
      heading: 'Cookies',
      paragraphs: [p('{Product} uses the cookies it needs to sign you in and keep your session secure. It does not use advertising cookies.')]
    },
    {
      heading: 'Your choices and rights',
      paragraphs: [
        p('You can see and correct your details in {product}. You can also ask for a copy of your personal data, ask us to correct or delete it, or object to how we use it, by writing to [contact].'),
        p('Depending on where you live, you may have other rights too, including complaining to your data protection authority.')
      ]
    },
    {
      heading: 'Changes to this notice',
      paragraphs: [p('We will post any change here with a new date, and tell the {owners} of the {accounts} it affects when a change matters.')]
    },
    {
      heading: 'Contact',
      paragraphs: [p('Questions or requests about your personal data: [contact].')]
    }
  ]
};

/** The facts a template places, in the order of the tokens' alternatives below. */
export const LEGAL_TOKEN = /\[(company|contact|jurisdiction|effective_date|terms|privacy)\]/g;

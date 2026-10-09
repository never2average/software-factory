import { readFileSync } from "node:fs";
import {
  customerStoreSchema,
  peopleStoreSchema,
} from "../agent/lib/customer-schema.ts";

const customersPath = new URL("../data/sample/customers.json", import.meta.url);
const peoplePath = new URL("../data/sample/people.json", import.meta.url);

const customerStore = customerStoreSchema.parse(JSON.parse(readFileSync(customersPath, "utf8")));
const peopleStore = peopleStoreSchema.parse(JSON.parse(readFileSync(peoplePath, "utf8")));

const customerIds = new Set(customerStore.customers.map((customer) => customer.id));
const peopleEmails = new Set([
  ...peopleStore.internalStaffAssignments.map((person) => person.email),
  ...peopleStore.customerStakeholders.map((person) => person.email),
]);
const internalStaffByCustomer = new Map();
const stakeholdersByCustomer = new Map();

for (const person of peopleStore.internalStaffAssignments) {
  const rows = internalStaffByCustomer.get(person.customer_id) ?? [];
  rows.push(person);
  internalStaffByCustomer.set(person.customer_id, rows);
}

for (const person of peopleStore.customerStakeholders) {
  const rows = stakeholdersByCustomer.get(person.customer_id) ?? [];
  rows.push(person);
  stakeholdersByCustomer.set(person.customer_id, rows);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasInternalStaff(customerId, email, role) {
  return (internalStaffByCustomer.get(customerId) ?? []).some(
    (person) => person.email === email && (!role || person.staffRole === role),
  );
}

function hasStakeholder(customerId, email) {
  return (stakeholdersByCustomer.get(customerId) ?? []).some((person) => person.email === email);
}

function hasPerson(customerId, email) {
  return hasInternalStaff(customerId, email) || hasStakeholder(customerId, email);
}

for (const person of [
  ...peopleStore.internalStaffAssignments,
  ...peopleStore.customerStakeholders,
]) {
  assert(customerIds.has(person.customer_id), `People row references unknown customer_id: ${person.customer_id}`);
}

for (const customer of customerStore.customers) {
  if (customer.fdeOwner) {
    assert(
      hasInternalStaff(customer.id, customer.fdeOwner, "solution_engineer"),
      `${customer.id} fdeOwner is not a same-customer solution_engineer: ${customer.fdeOwner}`,
    );
  }
  if (customer.aeOwner) {
    assert(
      hasInternalStaff(customer.id, customer.aeOwner, "account_executive"),
      `${customer.id} aeOwner is not a same-customer account_executive: ${customer.aeOwner}`,
    );
  }
  for (const ownerField of ["businessOwnerEmail", "technicalOwnerEmail", "executiveSponsorEmail"]) {
    if (customer[ownerField]) {
      assert(
        hasStakeholder(customer.id, customer[ownerField]),
        `${customer.id} ${ownerField} is not a same-customer stakeholder: ${customer[ownerField]}`,
      );
    }
  }

  const solutionIds = new Set((customer.solutions ?? []).map((solution) => solution.solutionId));
  const deploymentIds = new Set((customer.deployments ?? []).map((deployment) => deployment.deploymentId));
  const deploymentEnvironments = new Set((customer.deployments ?? []).map((deployment) => deployment.environment));
  const ticketIds = new Set((customer.tickets ?? []).map((ticket) => ticket.ticketId));

  for (const deployment of customer.deployments ?? []) {
    if (deployment.deployOwnerEmail) {
      assert(
        hasInternalStaff(customer.id, deployment.deployOwnerEmail),
        `${customer.id}/${deployment.deploymentId} deployOwnerEmail is not same-customer internal staff`,
      );
    }
    if (deployment.approvedByEmail) {
      assert(
        hasInternalStaff(customer.id, deployment.approvedByEmail),
        `${customer.id}/${deployment.deploymentId} approvedByEmail is not same-customer internal staff`,
      );
    }
    if (deployment.lastIncidentRef) {
      assert(ticketIds.has(deployment.lastIncidentRef), `${customer.id} lastIncidentRef missing ticket: ${deployment.lastIncidentRef}`);
    }
    for (const incidentRef of deployment.activeIncidentRefs ?? []) {
      assert(ticketIds.has(incidentRef), `${customer.id}/${deployment.deploymentId} activeIncidentRefs missing ticket: ${incidentRef}`);
    }
  }

  for (const solution of customer.solutions ?? []) {
    assert(solution.solutionId, `${customer.id} solution missing solutionId`);
    assert(
      hasInternalStaff(customer.id, solution.solutionFdeOwner, "solution_engineer"),
      `${customer.id}/${solution.solutionId} solutionFdeOwner is not a same-customer solution_engineer`,
    );
    for (const ownerField of ["workflowOwnerEmail", "riskOwnerEmail"]) {
      if (solution[ownerField]) {
        assert(
          hasStakeholder(customer.id, solution[ownerField]),
          `${customer.id}/${solution.solutionId} ${ownerField} is not a same-customer stakeholder`,
        );
      }
    }
  }

  if (customer.implementation) {
    for (const solutionId of customer.implementation.launchScopeSolutionIds ?? []) {
      assert(solutionIds.has(solutionId), `${customer.id} implementation launchScopeSolutionIds missing solution: ${solutionId}`);
    }
    if (customer.implementation.customerLaunchApproverEmail) {
      assert(
        hasStakeholder(customer.id, customer.implementation.customerLaunchApproverEmail),
        `${customer.id} customerLaunchApproverEmail is not a same-customer stakeholder`,
      );
    }
    for (const ownerField of ["implementationOwnerEmail", "providerLaunchApproverEmail", "supportOwnerEmail"]) {
      if (customer.implementation[ownerField]) {
        assert(
          hasInternalStaff(customer.id, customer.implementation[ownerField]),
          `${customer.id} implementation ${ownerField} is not same-customer internal staff`,
        );
      }
    }
    for (const ticketId of customer.implementation.criticalBlockerTicketIds ?? []) {
      assert(ticketIds.has(ticketId), `${customer.id} criticalBlockerTicketIds missing ticket: ${ticketId}`);
    }
  }

  for (const ticket of customer.tickets ?? []) {
    assert(hasInternalStaff(customer.id, ticket.ticketOwnerEmail), `${customer.id}/${ticket.ticketId} ticketOwnerEmail is not same-customer internal staff`);
    if (ticket.escalationOwnerEmail) {
      assert(
        hasInternalStaff(customer.id, ticket.escalationOwnerEmail),
        `${customer.id}/${ticket.ticketId} escalationOwnerEmail is not same-customer internal staff`,
      );
    }
    if (ticket.postmortemOwnerEmail) {
      assert(hasInternalStaff(customer.id, ticket.postmortemOwnerEmail), `${customer.id}/${ticket.ticketId} postmortemOwnerEmail is not same-customer internal staff`);
    }
    for (const contactField of ["reportedByEmail", "customerContactEmail"]) {
      if (ticket[contactField]) {
        assert(hasPerson(customer.id, ticket[contactField]), `${customer.id}/${ticket.ticketId} ${contactField} is not same-customer people`);
      }
    }
    if (ticket.affectedSolutionId) {
      assert(
        solutionIds.has(ticket.affectedSolutionId),
        `${customer.id}/${ticket.ticketId} affectedSolutionId is not in Solutions`,
      );
    }
    if (ticket.affectedDeploymentId) {
      assert(
        deploymentIds.has(ticket.affectedDeploymentId),
        `${customer.id}/${ticket.ticketId} affectedDeploymentId is not in Deployments`,
      );
    }
    if (ticket.affectedEnvironment) {
      assert(
        deploymentEnvironments.has(ticket.affectedEnvironment),
        `${customer.id}/${ticket.ticketId} affectedEnvironment is not in Deployments`,
      );
    }
    for (const relatedTicketId of ticket.relatedTicketIds ?? []) {
      assert(ticketIds.has(relatedTicketId), `${customer.id}/${ticket.ticketId} relatedTicketIds missing ticket: ${relatedTicketId}`);
    }
  }

  for (const interaction of customer.interactions ?? []) {
    for (const email of interaction.participantEmails ?? []) {
      assert(hasPerson(customer.id, email), `${customer.id}/${interaction.interactionId} participantEmails unknown person: ${email}`);
    }
    if (interaction.nextActionOwnerEmail) {
      assert(hasPerson(customer.id, interaction.nextActionOwnerEmail), `${customer.id}/${interaction.interactionId} nextActionOwnerEmail unknown person`);
    }
    if (interaction.recordedByEmail) {
      assert(hasPerson(customer.id, interaction.recordedByEmail), `${customer.id}/${interaction.interactionId} recordedByEmail unknown person`);
    }
    for (const solutionId of interaction.relatedSolutionIds ?? []) {
      assert(solutionIds.has(solutionId), `${customer.id}/${interaction.interactionId} relatedSolutionIds missing solution: ${solutionId}`);
    }
    for (const deploymentId of interaction.relatedDeploymentIds ?? []) {
      assert(deploymentIds.has(deploymentId), `${customer.id}/${interaction.interactionId} relatedDeploymentIds missing deployment: ${deploymentId}`);
    }
    for (const ticketId of interaction.relatedTicketIds ?? []) {
      assert(ticketIds.has(ticketId), `${customer.id}/${interaction.interactionId} relatedTicketIds missing ticket: ${ticketId}`);
    }
  }
}

console.log("schema validation ok");

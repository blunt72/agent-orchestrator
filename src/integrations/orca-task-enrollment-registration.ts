import { publishOrcaEnrollment, type OrcaEnrollmentPublicationInput } from "./orca-enrollment-publication.js";

/** Completion enrollment retains its REVIEW-only contract. */
export function registerOrcaTaskEnrollment(input:OrcaEnrollmentPublicationInput){
  return publishOrcaEnrollment(input,"review");
}

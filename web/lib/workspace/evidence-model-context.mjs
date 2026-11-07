const probability=value=>Number.isFinite(value)&&value>=0&&value<=1?value:null;

export function evidenceModelContext(evidence,research){
  const forecast=research?.forecast,feedback=forecast?.availability_feedback;
  const current=probability(forecast?.probability);
  const structured=feedback?.status==='available'&&current!==null;
  const baseline=structured?probability(feedback.baseline_probability):current;
  const matched=Array.isArray(evidence?.items)?evidence.items:[];
  const related=Array.isArray(evidence?.related_items)?evidence.related_items:[];
  const hasReports=matched.length+related.length>0;
  return {
    status:structured?'structured_update':hasReports?'report_context':'coverage_gap',
    ticker:evidence?.ticker,baseline_probability:baseline,current_probability:current,
    probability_adjustment:structured&&baseline!==null?current-baseline:null,
    decision_interval:structured?feedback.decision_interval:forecast?.interval??null,
    model_name:forecast?.model_name??null,source_as_of:forecast?.source_as_of??null,
    reporting_as_of:evidence?.as_of??null,matched_reports:matched.length,related_reports:related.length,
    update_role:structured?'verified_model_input':hasReports?'assumption_review':'evidence_gap',
    updates:[...matched,...related].slice(0,6).map(row=>({
      title:row.title,url:row.url,publisher:row.publisher,published_at:row.published_at??row.as_of,
      match_scope:row.match_scope,why_relevant:row.why_relevant,impact:row.impact
    })),
    reason:structured?'The verified availability observations were evaluated against historical player scenarios and are reflected in the decision range.':
      hasReports?'The selected reports identify facts to review alongside the independent model. Their quoted facts, dates and outcome relevance are included in the explanation. A numeric change requires a supported model input.':
      'The selected sources returned no fresh matching report. The independent estimate, when available, remains based on its dated structured observations.'
  };
}

use super::InnerVlConverter;
use crate::converter::transfer::JsonArgGuard;
use crate::converter::types::*;
use crate::converter::value_or_string::{apply_spec_overrides, ValueOrString};
use deno_core::anyhow::bail;
use deno_core::error::AnyError;

impl InnerVlConverter {
    pub(crate) async fn vega_to_tikz(
        &mut self,
        vg_spec: impl Into<ValueOrString>,
        vg_opts: VgOpts,
        tikz_opts: TikzOpts,
    ) -> Result<TikzOutput, AnyError> {
        self.init_vega().await?;
        let spec = apply_spec_overrides(
            vg_spec.into(),
            &vg_opts.background,
            vg_opts.width,
            vg_opts.height,
        )?;
        let format_locale = vg_opts
            .format_locale
            .map(|locale| locale.as_object())
            .transpose()?
            .unwrap_or(serde_json::Value::Null);
        let time_format_locale = vg_opts
            .time_format_locale
            .map(|locale| locale.as_object())
            .transpose()?
            .unwrap_or(serde_json::Value::Null);
        let spec_arg = JsonArgGuard::from_spec(&self.transfer_state, spec)?;
        let config_arg = JsonArgGuard::from_value(
            &self.transfer_state,
            vg_opts.config.unwrap_or(serde_json::Value::Null),
        )?;
        let format_arg = JsonArgGuard::from_value(&self.transfer_state, format_locale)?;
        let time_format_arg = JsonArgGuard::from_value(&self.transfer_state, time_format_locale)?;
        let options_arg =
            JsonArgGuard::from_value(&self.transfer_state, serde_json::to_value(tikz_opts)?)?;
        let code = format!(
            r#"
var tikz = undefined;
var errors = [];
_clearLogMessages();
vegaToTikz(
    JSON.parse(op_get_json_arg({spec_id})),
    JSON.parse(op_get_json_arg({format_id})),
    JSON.parse(op_get_json_arg({time_format_id})),
    JSON.parse(op_get_json_arg({config_id})),
    JSON.parse(op_get_json_arg({options_id})),
    errors,
).then((result) => {{ tikz = result; }});
"#,
            spec_id = spec_arg.id(),
            format_id = format_arg.id(),
            time_format_id = time_format_arg.id(),
            config_id = config_arg.id(),
            options_id = options_arg.id(),
        );
        self.worker.js_runtime.execute_script("ext:<anon>", code)?;
        self.worker
            .js_runtime
            .run_event_loop(Default::default())
            .await?;
        let access_errors = self
            .execute_script_to_string(
                "Array.isArray(errors) && errors.length > 0 ? errors.join('\\n') : ''",
            )
            .await?;
        self.emit_js_log_messages().await;
        if !access_errors.is_empty() {
            bail!("{access_errors}");
        }
        let tikz = self.execute_script_to_string("tikz").await?;
        Ok(TikzOutput {
            tikz,
            logs: std::mem::take(&mut self.last_log_entries),
            google_fonts: Default::default(),
        })
    }

    pub(crate) async fn vegalite_to_tikz(
        &mut self,
        vl_spec: impl Into<ValueOrString>,
        vl_opts: VlOpts,
        tikz_opts: TikzOpts,
    ) -> Result<TikzOutput, AnyError> {
        // Compile through the existing implementation so every bundled compiler,
        // theme, config and size override follows the same behavior as other formats.
        let vg_opts = VgOpts {
            format_locale: vl_opts.format_locale.clone(),
            time_format_locale: vl_opts.time_format_locale.clone(),
            ..Default::default()
        };
        let compiled = self.vegalite_to_vega(vl_spec, vl_opts).await?;
        let mut output = self.vega_to_tikz(compiled.spec, vg_opts, tikz_opts).await?;
        let mut logs = compiled.logs;
        logs.append(&mut output.logs);
        output.logs = logs;
        Ok(output)
    }
}

use super::{
    error_with_google_font_usage, InnerVlConverter, TikzOpts, TikzOutput, ValueOrString, VgOpts,
    VlConverter, VlOpts,
};
use crate::with_font_overlay;
use deno_core::error::AnyError;

impl VlConverter {
    /// Convert an evaluated Vega scenegraph to an experimental TikZ picture.
    ///
    /// Uses Vega's existing Canvas renderer to draw paths and labels, preserving
    /// evaluated scales, guides and layout. The output needs the LaTeX `tikz`
    /// package; no TeX installation is needed during conversion. See [`TikzOpts`]
    /// for label handling and font-metric limitations. Unsupported drawing
    /// features return errors instead of being omitted.
    ///
    /// Uses the converter's data-access, font, plugin and JavaScript-limit settings.
    pub async fn vega_to_tikz(
        &self,
        vg_spec: impl Into<ValueOrString>,
        mut vg_opts: VgOpts,
        tikz_opts: TikzOpts,
    ) -> Result<TikzOutput, AnyError> {
        self.apply_vg_defaults(&mut vg_opts);
        let vg_spec = vg_spec.into();
        let plugin = vg_opts.vega_plugin.take();

        let font_analysis = self
            .maybe_preprocess_vega_fonts(&vg_spec, vg_opts.google_fonts.as_deref())
            .await?;
        if !font_analysis.requests.is_empty() {
            vg_opts
                .google_fonts
                .get_or_insert_with(Vec::new)
                .extend(font_analysis.requests);
        }

        let output_result = self
            .run_tikz_on_worker(plugin, move |inner| {
                let gf = vg_opts.google_fonts.take();
                let inner = &mut *inner;
                Box::pin(async move {
                    with_font_overlay!(
                        inner,
                        gf,
                        inner.vega_to_tikz(vg_spec, vg_opts, tikz_opts).await
                    )
                })
            })
            .await;
        let mut output = output_result
            .map_err(|err| error_with_google_font_usage(err, font_analysis.google_fonts.clone()))?;
        output.google_fonts.add_assign(font_analysis.google_fonts);

        Ok(output)
    }

    /// Compile Vega-Lite and render the evaluated scenegraph as experimental TikZ.
    ///
    /// Vega-Lite and Vega perform all data transforms, scale resolution, guide
    /// generation and composition layout. This method draws the result with the
    /// same backend as [`Self::vega_to_tikz`]. See [`TikzOpts`] for label policy.
    pub async fn vegalite_to_tikz(
        &self,
        vl_spec: impl Into<ValueOrString>,
        mut vl_opts: VlOpts,
        tikz_opts: TikzOpts,
    ) -> Result<TikzOutput, AnyError> {
        self.apply_vl_defaults(&mut vl_opts);
        let vl_spec = vl_spec.into();
        let plugin = vl_opts.vega_plugin.take();

        let output = if let Some((vega_spec, mut vg_opts, compile_logs, preprocess_google_fonts)) =
            self.maybe_compile_vl_with_preprocessed_fonts(&vl_spec, &vl_opts)
                .await?
        {
            let vg_spec: ValueOrString = vega_spec.into();
            let output_result = self
                .run_tikz_on_worker(plugin, move |inner| {
                    let gf = vg_opts.google_fonts.take();
                    let inner = &mut *inner;
                    Box::pin(async move {
                        with_font_overlay!(
                            inner,
                            gf,
                            inner.vega_to_tikz(vg_spec, vg_opts, tikz_opts).await
                        )
                    })
                })
                .await;
            let mut output = output_result.map_err(|err| {
                error_with_google_font_usage(err, preprocess_google_fonts.clone())
            })?;
            let mut all_logs = compile_logs;
            all_logs.extend(output.logs);
            output.logs = all_logs;
            output.google_fonts.add_assign(preprocess_google_fonts);
            output
        } else {
            self.run_tikz_on_worker(plugin, move |inner| {
                let gf = vl_opts.google_fonts.take();
                let inner = &mut *inner;
                Box::pin(async move {
                    with_font_overlay!(
                        inner,
                        gf,
                        inner.vegalite_to_tikz(vl_spec, vl_opts, tikz_opts).await
                    )
                })
            })
            .await?
        };

        Ok(output)
    }

    // Preserve the existing worker/plugin lifecycle while keeping each TikZ
    // conversion and its font overlay in one place. Other exporters are unchanged.
    async fn run_tikz_on_worker(
        &self,
        plugin: Option<String>,
        work: impl FnOnce(
                &mut InnerVlConverter,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<TikzOutput, AnyError>> + '_>,
            > + Send
            + 'static,
    ) -> Result<TikzOutput, AnyError> {
        match plugin {
            Some(source) => self.run_on_ephemeral_worker(source, work).await,
            None => self.run_on_worker(work).await,
        }
    }
}
